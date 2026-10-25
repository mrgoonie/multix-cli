/**
 * fal commands through commander with a stubbed fetch: local file upload,
 * `run --file --detach` with a persisted receipt, resuming with `result`
 * from a fresh program (no new submit), pending results, and an unchanged
 * default `run`. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";

const KEY = "fal-test-secret";
const QUEUE = "https://queue.fal.run";
const MODEL = "fal-ai/mmaudio-v2";
const REQ = "req-0001";
const UPLOAD = "https://storage.fal.test/upload/xyz?sig=SIGNED";
const FILE_URL = "https://v3b.fal.media/files/b/xyz_shot.mp4";
const OUT_URL = "https://v3b.fal.media/files/b/out.mp4";

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

let tmp: string;
let stdout: string[];
let stderr: string[];
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake fal: storage, queue submit/status/result and the media CDN. */
function stubFal(opts: { status?: string; resultStatus?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        url,
        auth: headers.authorization ?? headers.Authorization,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
        return json({ upload_url: UPLOAD, file_url: FILE_URL });
      }
      if (url === UPLOAD) return new Response(null, { status: 200 });
      if (method === "POST" && url === `${QUEUE}/${MODEL}`) {
        return json({
          request_id: REQ,
          status_url: `${QUEUE}/fal-ai/mmaudio-v2/requests/${REQ}/status`,
          response_url: `${QUEUE}/fal-ai/mmaudio-v2/requests/${REQ}`,
          queue_position: 0,
        });
      }
      if (url.endsWith(`/requests/${REQ}/status`)) {
        return json({ status: opts.status ?? "COMPLETED", queue_position: 3 });
      }
      if (url === `${QUEUE}/fal-ai/mmaudio-v2/requests/${REQ}`) {
        if (opts.resultStatus && opts.resultStatus !== 200) {
          return json({ detail: "Request is still in progress" }, opts.resultStatus);
        }
        return json({ video: { url: OUT_URL } });
      }
      if (url === OUT_URL) {
        return new Response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
}

async function fal(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerFalCommands(program);
  await program.parseAsync(["node", "multix", "fal", ...args]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-cmd-"));
  vi.stubEnv("HOME", path.join(tmp, "home"));
  vi.stubEnv("USERPROFILE", path.join(tmp, "home"));
  vi.stubEnv("FAL_KEY", KEY);
  vi.stubEnv("FAL_BASE_URL", "");
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  stdout = [];
  stderr = [];
  calls = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    stdout.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a) => {
    stderr.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a) => {
    stderr.push(a.map(String).join(" "));
  });
  fs.writeFileSync(path.join(tmp, "shot.mp4"), Buffer.from("fake video bytes"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("fal upload", () => {
  it("prints only the hosted URL JSON on stdout", async () => {
    stubFal();
    await fal("upload", path.join(tmp, "shot.mp4"), "--expires-in", "1d");
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toEqual({
      url: FILE_URL,
      file_name: "shot.mp4",
      mime_type: "video/mp4",
      size_bytes: 16,
      expires_in_s: 86400,
    });
    expect(calls.find((c) => c.url === UPLOAD)?.auth).toBeUndefined();
    const logs = stderr.join("\n");
    expect(logs).toContain("anyone with the returned URL can read it");
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain("SIGNED");
  });

  it("rejects a missing, empty or directory path before any request", async () => {
    stubFal();
    fs.writeFileSync(path.join(tmp, "empty.wav"), "");
    await expect(fal("upload", path.join(tmp, "nope.mp4"))).rejects.toThrow(/not found/);
    await expect(fal("upload", path.join(tmp, "empty.wav"))).rejects.toThrow(/empty/);
    await expect(fal("upload", tmp)).rejects.toThrow(/not a file/);
    expect(calls).toHaveLength(0);
  });
});

describe("fal run --file --detach, then resume", () => {
  it("uploads, submits once, saves a receipt and resumes without submitting again", async () => {
    stubFal();
    await fal(
      "run",
      MODEL,
      "--input",
      '{"prompt":"beeps","duration":2}',
      "--file",
      `video_url=${path.join(tmp, "shot.mp4")}`,
      "--detach",
    );

    const submits = calls.filter((c) => c.method === "POST" && c.url.startsWith(QUEUE));
    expect(submits).toHaveLength(1);
    expect(submits[0]?.body).toEqual({ prompt: "beeps", duration: 2, video_url: FILE_URL });
    expect(submits[0]?.auth).toBe(`Key ${KEY}`);
    // Detached: no polling after submit.
    expect(calls.some((c) => c.url.endsWith("/status"))).toBe(false);

    expect(stdout).toHaveLength(1);
    const receipt = JSON.parse(stdout[0] ?? "");
    const receiptPath = path.join(tmp, "home", ".multix", "fal", "requests", `${REQ}.json`);
    expect(receipt).toMatchObject({
      schema: "multix.fal-receipt/v1",
      model: MODEL,
      request_id: REQ,
      status: "IN_QUEUE",
      receipt_path: receiptPath,
    });
    expect(receipt.input_hash).toMatch(/^sha256:/);
    const saved = fs.readFileSync(receiptPath, "utf8");
    expect(JSON.parse(saved).request_id).toBe(REQ);
    expect(saved).not.toContain(KEY);
    expect(saved).not.toContain(FILE_URL);
    expect(saved).not.toContain("SIGNED");

    // A later process: result --download reads only.
    calls = [];
    stdout = [];
    _resetOutputDir();
    await fal("result", MODEL, REQ, "--download", "--output-dir", path.join(tmp, "dl"));
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(fs.readdirSync(path.join(tmp, "dl"))).toHaveLength(1);
  });

  it("passes URL values through without uploading", async () => {
    stubFal();
    await fal(
      "run",
      MODEL,
      "--input",
      "{}",
      "--file",
      "video_url=https://example.com/shot.mp4",
      "--detach",
      "--receipt",
      path.join(tmp, "r.json"),
    );
    expect(calls.some((c) => c.url.includes("rest.fal.ai"))).toBe(false);
    const submit = calls.find((c) => c.method === "POST");
    expect(submit?.body).toEqual({ video_url: "https://example.com/shot.mp4" });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "r.json"), "utf8")).request_id).toBe(REQ);
  });

  it("checks every local file before uploading any", async () => {
    stubFal();
    await expect(
      fal(
        "run",
        MODEL,
        "--input",
        "{}",
        "--file",
        `video_url=${path.join(tmp, "shot.mp4")}`,
        "--file",
        `audio_url=${path.join(tmp, "missing.wav")}`,
        "--detach",
      ),
    ).rejects.toThrow(/missing\.wav/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed --file", async () => {
    stubFal();
    await expect(fal("run", MODEL, "--input", "{}", "--file", "video_url")).rejects.toThrow(
      /expected key=path/,
    );
  });
});

describe("fal result for a job that is not finished", () => {
  it("fails with JOB_PENDING and the queue status, without submitting", async () => {
    stubFal({ status: "IN_PROGRESS", resultStatus: 400 });
    const err = await fal("result", MODEL, REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/is IN_PROGRESS \(queue position 3\); no result yet/);
    const info = classifyError(err);
    expect(info).toMatchObject({ code: "JOB_PENDING", retryable: false, exit_code: 6 });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("fal run without the new flags", () => {
  it("still submits, polls and downloads", async () => {
    stubFal();
    await fal("run", MODEL, "--input", '{"prompt":"x"}', "--wait-timeout", "5000");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET"]);
    expect(stdout.join("\n")).toContain("Downloaded 1 file(s)");
    expect(fs.readdirSync(path.join(tmp, "out"))).toHaveLength(1);
  });
});
