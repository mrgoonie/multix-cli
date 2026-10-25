/**
 * End-to-end (mocked HTTP) flow for local media + detached jobs:
 * fal upload → fal submit --file → (new process) fal status/result --download,
 * plus receipts, unknown_remote_state and `fal run` backward compatibility.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";
import {
  buildReceipt,
  inputHash,
  listReceipts,
  readReceipt,
  saveReceipt,
} from "../../../../src/providers/fal/job-receipts.js";
import { UnknownRemoteStateError } from "../../../../src/providers/fal/run-helpers.js";

const MODEL = "fal-ai/mmaudio-v2";
const REQ = "req-abc123";
const STATUS_URL = `https://queue.fal.run/${MODEL}/requests/${REQ}/status`;
const RESPONSE_URL = `https://queue.fal.run/${MODEL}/requests/${REQ}`;

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

let dir: string;
let calls: Call[];
let stdout: string[];
let submitBehavior: "ok" | "network-error";
let jobStatus: string;
const env = { ...process.env };

function installFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body,
    });
    if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
      return Response.json({
        upload_url: "https://upload.fal.test/put/1?X-Sig=signed-secret",
        file_url: "https://v3.fal.media/files/shot-hosted.mp4",
      });
    }
    if (url.startsWith("https://upload.fal.test/")) return new Response("", { status: 200 });
    if (url === `https://queue.fal.run/${MODEL}` && method === "POST") {
      if (submitBehavior === "network-error") throw new TypeError("fetch failed");
      return Response.json({ request_id: REQ, status_url: STATUS_URL, response_url: RESPONSE_URL });
    }
    if (url === STATUS_URL) return Response.json({ status: jobStatus, request_id: REQ });
    if (url === RESPONSE_URL) {
      return Response.json({ video: { url: "https://v3.fal.media/files/out.mp4" } });
    }
    if (url === "https://v3.fal.media/files/out.mp4") {
      return new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

/** One CLI invocation, as a fresh program (state between runs lives only on disk). */
async function cli(...args: string[]): Promise<string> {
  stdout = [];
  const program = new Command().exitOverride();
  registerFalCommands(program);
  await program.parseAsync(["node", "multix", "fal", ...args]);
  return stdout.join("\n");
}

const submits = () =>
  calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-jobs-"));
  process.env.FAL_KEY = "fal-test-key-123456";
  process.env.MULTIX_FAL_JOBS_DIR = path.join(dir, "jobs");
  process.env.MULTIX_OUTPUT_DIR = path.join(dir, "out");
  process.env.FAL_BASE_URL = "";
  _resetOutputDir();
  calls = [];
  stdout = [];
  submitBehavior = "ok";
  jobStatus = "IN_PROGRESS";
  installFetch();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...env };
  _resetOutputDir();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fal upload", () => {
  it("prints clean JSON with url, MIME type and size; key only to rest.fal.ai", async () => {
    const shot = path.join(dir, "shot.mp4");
    fs.writeFileSync(shot, Buffer.alloc(10));
    const out = await cli("upload", shot);
    expect(JSON.parse(out)).toEqual({
      url: "https://v3.fal.media/files/shot-hosted.mp4",
      file_name: "shot.mp4",
      mime_type: "video/mp4",
      size_bytes: 10,
    });
    expect(out).not.toContain("signed-secret");
    for (const c of calls) {
      if (c.auth) expect(new URL(c.url).host).toBe("rest.fal.ai");
    }
  });

  it("fails on a missing file without any request", async () => {
    await expect(cli("upload", path.join(dir, "missing.mp4"))).rejects.toThrow(/File not found/);
    expect(calls).toHaveLength(0);
  });
});

describe("fal submit → status/result after restart", () => {
  it("uploads --file, submits once, persists a receipt and resumes without resubmitting", async () => {
    const shot = path.join(dir, "shot.mp4");
    fs.writeFileSync(shot, Buffer.alloc(5));
    const out = await cli(
      "submit",
      MODEL,
      "--input",
      '{"prompt":"rain on tin roof","duration":8}',
      "--file",
      `video_url=${shot}`,
    );
    const receipt = JSON.parse(out);
    expect(receipt).toMatchObject({
      schema: "multix.fal.job/v1",
      provider: "fal",
      model: MODEL,
      request_id: REQ,
      status: "IN_QUEUE",
      uploaded_fields: ["video_url"],
    });
    const sent = JSON.parse(String(submits()[0]?.body));
    expect(sent).toEqual({
      prompt: "rain on tin roof",
      duration: 8,
      video_url: "https://v3.fal.media/files/shot-hosted.mp4",
    });
    expect(receipt.input_hash).toBe(inputHash(sent));
    // No polling in submit mode.
    expect(calls.some((c) => c.url === STATUS_URL)).toBe(false);

    // Receipt on disk, private, without the key or the uploaded URL.
    const file = receipt.receipt_path as string;
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("fal-test-key");
    expect(raw).not.toContain("shot-hosted");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // A later process: status and result by request id alone.
    const status = JSON.parse(await cli("status", REQ));
    expect(status.status).toBe("IN_PROGRESS");
    expect(readReceipt(REQ)?.status).toBe("IN_PROGRESS");

    jobStatus = "COMPLETED";
    await cli("status", MODEL, REQ);
    const dl = await cli("result", REQ, "--download");
    expect(dl).toContain("Downloaded 1 file(s)");
    const saved = fs.readdirSync(path.join(dir, "out"));
    expect(saved).toEqual(["fal-req-abc1-01.mp4"]);
    expect(readReceipt(REQ)?.status).toBe("COMPLETED");

    // Exactly one paid submit across the whole flow.
    expect(submits()).toHaveLength(1);
  });

  it("downloads to --output-dir", async () => {
    saveReceipt(
      buildReceipt(
        MODEL,
        {},
        { request_id: REQ, status_url: STATUS_URL, response_url: RESPONSE_URL },
      ),
    );
    const target = path.join(dir, "custom");
    await cli("result", MODEL, REQ, "--download", "--output-dir", target);
    expect(fs.readdirSync(target)).toEqual(["fal-req-abc1-01.mp4"]);
  });

  it("asks for the model when no receipt exists", async () => {
    await expect(cli("status", "req-unknown")).rejects.toThrow(/No saved receipt/);
    expect(calls).toHaveLength(0);
  });

  it("reports unknown_remote_state, saves no receipt and does not retry the POST", async () => {
    submitBehavior = "network-error";
    const err = await cli("submit", MODEL, "--input", '{"prompt":"x"}').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRemoteStateError);
    expect(classifyError(err).code).toBe("UNKNOWN_REMOTE_STATE");
    expect(classifyError(err).retryable).toBe(false);
    expect(submits()).toHaveLength(1);
    expect(listReceipts()).toEqual([]);
  });

  it("needs --input or --file", async () => {
    await expect(cli("submit", MODEL)).rejects.toThrow(/--input/);
    expect(calls).toHaveLength(0);
  });

  it("lists receipts newest first", async () => {
    await cli("submit", MODEL, "--input", "{}");
    const jobs = JSON.parse(await cli("jobs"));
    expect(jobs.jobs.map((j: { request_id: string }) => j.request_id)).toEqual([REQ]);
  });
});

describe("fal run (unchanged default flow)", () => {
  it("still waits and prints the result with --no-download, and saves a receipt", async () => {
    jobStatus = "COMPLETED";
    const out = await cli("run", MODEL, "--input", '{"prompt":"x"}', "--no-download");
    expect(out).toContain('"url": "https://v3.fal.media/files/out.mp4"');
    expect(readReceipt(REQ)?.model).toBe(MODEL);
    expect(submits()).toHaveLength(1);
  });
});
