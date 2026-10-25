/**
 * fal commands driven through commander with the real env-based client and a
 * scripted fake of fal (global fetch stubbed): local upload, `--file`,
 * `--detach` receipts, resume via status/result, and the unchanged default
 * submit-wait-download flow. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { MultixError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";
import {
  FILE_URL,
  INITIATE,
  KEY,
  REQUEST_ID,
  UPLOAD_URL,
  createFakeFal,
  queueUrls,
} from "./fake-fal.js";

const MODEL = "fal-ai/mmaudio-v2";
const SUBMIT = `https://queue.fal.run/${MODEL}`;

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-cmd-"));
  vi.stubEnv("HOME", tmp);
  vi.stubEnv("USERPROFILE", tmp);
  vi.stubEnv("FAL_KEY", KEY);
  vi.stubEnv("FAL_BASE_URL", "");
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  for (const m of ["warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(" "));
    });
  }
  fs.writeFileSync(path.join(tmp, "shot.mp4"), "fake video bytes");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeFal>[0]) {
  const fake = createFakeFal(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function cli(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => stderr.push(s), writeOut: (s) => stdout.push(s) });
  registerFalCommands(program);
  await program.parseAsync(["node", "multix", "fal", ...args]);
}

const uploadRoutes = {
  [`POST ${INITIATE}`]: [{ json: { upload_url: UPLOAD_URL, file_url: FILE_URL } }],
  "PUT https://storage.example-cdn.test/": [{ status: 200 }],
};

const submitRoute = {
  [`POST ${SUBMIT}`]: [
    { json: { request_id: REQUEST_ID, status: "IN_QUEUE", ...queueUrls(MODEL) } },
  ],
};

function receiptFile(): string {
  return path.join(tmp, ".multix", "fal", "requests", `${REQUEST_ID}.json`);
}

describe("fal upload", () => {
  it("prints clean JSON with url, mime type and size; progress stays on stderr", async () => {
    stub(uploadRoutes);
    await cli("upload", path.join(tmp, "shot.mp4"));
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      url: FILE_URL,
      mime_type: "video/mp4",
      size_bytes: 16,
      file_name: "shot.mp4",
    });
    expect(stderr.join("\n")).toMatch(/public to anyone holding the link/);
    expect(stderr.join("\n")).not.toContain("X-Goog-Signature");
  });

  it("refuses non-media, missing and empty files before any request", async () => {
    const fake = stub(uploadRoutes);
    fs.writeFileSync(path.join(tmp, ".env"), "FAL_KEY=x");
    fs.writeFileSync(path.join(tmp, "empty.wav"), "");
    for (const f of [".env", "missing.mp4", "empty.wav"]) {
      await expect(cli("upload", path.join(tmp, f))).rejects.toBeInstanceOf(ValidationError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("honours FAL_MAX_UPLOAD_MB", async () => {
    const fake = stub(uploadRoutes);
    vi.stubEnv("FAL_MAX_UPLOAD_MB", "0.00001");
    await expect(cli("upload", path.join(tmp, "shot.mp4"))).rejects.toThrow(/upload limit/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("fal run --file --detach", () => {
  it("uploads, submits once, saves a 0600 receipt and returns without polling", async () => {
    const fake = stub({ ...uploadRoutes, ...submitRoute });
    fs.writeFileSync(path.join(tmp, "in.json"), JSON.stringify({ prompt: "rain on a tin roof" }));
    await cli(
      "run",
      MODEL,
      "--input",
      `@${path.join(tmp, "in.json")}`,
      "--file",
      `video_url=${path.join(tmp, "shot.mp4")}`,
      "--detach",
    );

    const submits = fake.calls.filter((c) => c.url.startsWith(SUBMIT));
    expect(submits).toHaveLength(1);
    expect(JSON.parse(String(submits[0]?.body))).toEqual({
      prompt: "rain on a tin roof",
      video_url: FILE_URL,
    });
    expect(fake.calls.some((c) => c.method === "GET")).toBe(false);

    const receipt = JSON.parse(stdout.join("\n"));
    expect(receipt).toMatchObject({
      provider: "fal",
      model: MODEL,
      request_id: REQUEST_ID,
      status: "IN_QUEUE",
      receipt_path: receiptFile(),
      status_command: `multix fal status ${MODEL} ${REQUEST_ID}`,
      result_command: `multix fal result ${MODEL} ${REQUEST_ID} --download`,
    });
    expect(receipt.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const saved = fs.readFileSync(receiptFile(), "utf8");
    expect(JSON.parse(saved)).toEqual(receipt);
    expect(saved).not.toContain(FILE_URL);
    expect(saved).not.toContain("rain on a tin roof");
    expect(saved).not.toContain(KEY);
    if (process.platform !== "win32") {
      expect(fs.statSync(receiptFile()).mode & 0o777).toBe(0o600);
    }
  });

  it("writes the receipt to --receipt and needs no --input with --file", async () => {
    const fake = stub({ ...uploadRoutes, ...submitRoute });
    const target = path.join(tmp, "jobs", "shot-01.json");
    await cli(
      "run",
      MODEL,
      "--file",
      `video_url=${path.join(tmp, "shot.mp4")}`,
      "--detach",
      "--receipt",
      target,
    );
    expect(JSON.parse(fs.readFileSync(target, "utf8")).request_id).toBe(REQUEST_ID);
    expect(fake.calls.filter((c) => c.url.startsWith(SUBMIT))).toHaveLength(1);
  });

  it("validates every --file before uploading anything", async () => {
    const fake = stub({ ...uploadRoutes, ...submitRoute });
    await expect(
      cli(
        "run",
        MODEL,
        "--file",
        `video_url=${path.join(tmp, "shot.mp4")}`,
        "--file",
        `audio_url=${path.join(tmp, "missing.wav")}`,
        "--detach",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects malformed --file values and prototype keys", async () => {
    const fake = stub(submitRoute);
    for (const bad of [
      "video_url",
      "=x.mp4",
      "__proto__.polluted=x.mp4",
      "video_url=https://example.com/a.mp4",
    ]) {
      await expect(cli("run", MODEL, "--file", bad, "--detach")).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("sets nested fields, appends to arrays and uploads a repeated path once", async () => {
    const fake = stub({ ...uploadRoutes, ...submitRoute });
    const shot = path.join(tmp, "shot.mp4");
    await cli(
      "run",
      MODEL,
      "--input",
      '{"refs":["https://example.com/keep.png"]}',
      "--file",
      `media.video.url=${shot}`,
      "--file",
      `refs[]=${shot}`,
      "--detach",
    );
    expect(fake.calls.filter((c) => c.url.startsWith(INITIATE))).toHaveLength(1);
    const body = JSON.parse(String(fake.calls.find((c) => c.url.startsWith(SUBMIT))?.body));
    expect(body).toEqual({
      refs: ["https://example.com/keep.png", FILE_URL],
      media: { video: { url: FILE_URL } },
    });
  });

  it("requires --input or --file", async () => {
    stub(submitRoute);
    await expect(cli("run", MODEL, "--detach")).rejects.toThrow(/--input/);
  });
});

describe("resume after the submitting process is gone", () => {
  it("status and result --download only read; nothing is submitted again", async () => {
    stub({ ...submitRoute });
    await cli("run", MODEL, "--input", '{"prompt":"x"}', "--detach");
    const receipt = JSON.parse(fs.readFileSync(receiptFile(), "utf8"));

    stdout = [];
    const app = "fal-ai/mmaudio-v2";
    const fake = stub({
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`]: [
        { json: { status: "COMPLETED" } },
      ],
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}`]: [
        { json: { video: { url: "https://v3.fal.media/files/out/result.mp4" } } },
      ],
      "GET https://v3.fal.media/files/out/": [{ status: 200, json: "bytes" }],
    });
    await cli("status", receipt.model, receipt.request_id);
    expect(JSON.parse(stdout.join("\n")).status).toBe("COMPLETED");

    stdout = [];
    const outDir = path.join(tmp, "custom-out");
    await cli("result", receipt.model, receipt.request_id, "--download", "--output-dir", outDir);
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
    const saved = fs.readdirSync(outDir);
    expect(saved).toEqual([`fal-${REQUEST_ID.slice(0, 8)}-01.mp4`]);
    // Downloads from the CDN never carry the key.
    const cdn = fake.calls.find((c) => c.url.startsWith("https://v3.fal.media/"));
    expect(cdn?.headers.authorization).toBeUndefined();
  });
});

describe("submit cut off before fal answered", () => {
  it("reports UNKNOWN_REMOTE_STATE, does not retry the POST and saves no receipt", async () => {
    const fake = stub({ [`POST ${SUBMIT}`]: [{ error: new TypeError("fetch failed") }] });
    const err = await cli("run", MODEL, "--input", '{"prompt":"x"}', "--detach").catch((e) => e);
    expect(err).toBeInstanceOf(MultixError);
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    const info = classifyError(err);
    expect(info.code).toBe("UNKNOWN_REMOTE_STATE");
    expect(info.retryable).toBe(false);
    expect(info.exit_code).toBe(6);
    expect(fake.calls).toHaveLength(1);
    expect(fs.existsSync(receiptFile())).toBe(false);
  });

  it("refuses an untrusted status_url before saving a receipt or polling", async () => {
    const fake = stub({
      [`POST ${SUBMIT}`]: [
        {
          json: {
            request_id: REQUEST_ID,
            status_url: "https://evil.example/status",
            response_url: queueUrls(MODEL).response_url,
          },
        },
      ],
    });
    await expect(cli("run", MODEL, "--input", "{}", "--detach")).rejects.toThrow(/evil\.example/);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("fal run without --detach (unchanged default)", () => {
  it("submits, waits, downloads, and also leaves a receipt", async () => {
    const app = "fal-ai/mmaudio-v2";
    const fake = stub({
      ...submitRoute,
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`]: [
        { json: { status: "COMPLETED" } },
      ],
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}`]: [
        { json: { audio: { url: "https://v3.fal.media/files/out/a.wav" } } },
      ],
      "GET https://v3.fal.media/files/out/": [{ status: 200, json: "bytes" }],
    });
    await cli("run", MODEL, "--input", '{"prompt":"x"}');
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(stdout.join("\n")).toMatch(/Downloaded 1 file\(s\)/);
    expect(fs.existsSync(receiptFile())).toBe(true);
  });

  it("--no-download prints only the result JSON on stdout", async () => {
    const app = "fal-ai/mmaudio-v2";
    stub({
      ...submitRoute,
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`]: [
        { json: { status: "COMPLETED" } },
      ],
      [`GET https://queue.fal.run/${app}/requests/${REQUEST_ID}`]: [{ json: { text: "ok" } }],
    });
    await cli("run", MODEL, "--input", '{"prompt":"x"}', "--no-download");
    expect(JSON.parse(stdout.join("\n"))).toEqual({ text: "ok" });
  });
});
