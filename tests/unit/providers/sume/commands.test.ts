/**
 * Sume commands driven through commander with the real env-based client
 * (global fetch stubbed with the fake Sume API): validation before any paid
 * request, submit → status → result → download, uploads and the SSRF guard,
 * status/cancel, the cached model list and Sume's quote. No network, and no
 * key, prompt or signed URL in what the commands print.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { SumeJobError } from "../../../../src/providers/sume/client.js";
import { registerSumeCommands } from "../../../../src/providers/sume/commands/index.js";
import {
  ARTIFACT_URL,
  BASE,
  JOB_ID,
  KEY,
  PUBLIC_URL,
  UPLOAD_URL,
  catalogBody,
  createFakeSume,
  result,
  status,
  submitted,
  sumeError,
} from "./fake-sume.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PROMPT = "a private prompt about a red fox";
const CATALOG = "GET /v1/open/catalog";
const IMAGE_SUBMIT = "POST /v1/image-router/generate";
const VIDEO_SUBMIT = "POST /v1/video-router/generate";
const STATUS = `GET /v1/jobs/${JOB_ID}/status`;
const RESULT = `GET /v1/jobs/${JOB_ID}/result`;
const JOB = `GET /v1/jobs/${JOB_ID}`;
const CANCEL = `POST /v1/jobs/${JOB_ID}/cancel`;

let tmp: string;
let output: string[];
/** console.log only: what a pipe (`| jq`) would read. */
let stdout: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-sume-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("MULTIX_CACHE_DIR", path.join(tmp, "cache"));
  vi.stubEnv("SUME_API_KEY", KEY);
  vi.stubEnv("SUME_BASE_URL", BASE);
  vi.stubEnv("SUME_IMAGE_MODEL", "");
  vi.stubEnv("SUME_VIDEO_MODEL", "");
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  stdout = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    capture(...args);
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeSume>[0]) {
  const fake = createFakeSume(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerSumeCommands(program);
  await program.parseAsync(["node", "multix", "sume", ...args]);
}

const text = () => output.join("\n");

/** Nothing secret reaches the terminal: key, prompt, signed URLs. */
function expectNoSecrets(): void {
  const all = text();
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(PROMPT);
  expect(all).not.toContain("UPLOAD_SIGNATURE_456");
}

describe("before any paid request", () => {
  it("needs a model, named by --model or the env, and points at the list", async () => {
    const fake = stub({});
    const error = await run("image", PROMPT).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(
      /pass -m <id> or set SUME_IMAGE_MODEL.*multix sume models --kind image/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("needs a key", async () => {
    vi.stubEnv("SUME_API_KEY", "");
    const fake = stub({});
    await expect(run("video", "x", "-m", "veo-3.1")).rejects.toBeInstanceOf(ConfigError);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [
      ["image", PROMPT, "-m", "nano-banana-2.1", "--resolution", "8K"],
      /--resolution 8K is not supported/,
    ],
    [["image", PROMPT, "-m", "nano-banana-2.1", "--param", "seed=3"], /not a request field/],
    [["image", PROMPT, "-m", "unknown-model"], /does not list model unknown-model/],
    [["video", "x", "-m", "veo-3.1", "--duration", "5"], /one of 4, 6, 8/],
    [
      ["video", "x", "-m", "sume-remix-restyle", "--video", "https://cdn.example.com/v.mp4"],
      /special Sume route/,
    ],
    [
      ["image", PROMPT, "-m", "nano-banana-2.1", "--image", "https://127.0.0.1/x.png"],
      /--image: cannot use 127\.0\.0\.1: it points to a local or private address/,
    ],
    [
      ["image", PROMPT, "-m", "nano-banana-2.1", "--image", "http://cdn.example.com/x.png"],
      /only https/,
    ],
    [["image", PROMPT, "-m", "nano-banana-2.1", "--image", "missing.png"], /file not found/],
    [["image", PROMPT, "-m", "nano-banana-2.1", "--output", "x.png"], /need --wait/],
  ])("refuses %j with only the catalog read", async (args, message) => {
    const fake = stub({ [CATALOG]: [{ json: catalogBody() }] });
    const error = await run(...args).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(message);
    expect(fake.calls.every((c) => c.method === "GET" && c.url.endsWith("/v1/open/catalog"))).toBe(
      true,
    );
  });

  it("refuses a local file of the wrong type for the flag", async () => {
    const audio = path.join(tmp, "speech.mp3");
    fs.writeFileSync(audio, "ID3");
    const fake = stub({ [CATALOG]: [{ json: catalogBody() }] });
    await expect(run("image", PROMPT, "-m", "nano-banana-2.1", "--image", audio)).rejects.toThrow(
      /--image must be an image file/,
    );
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("sume image", () => {
  it("submits async and prints the job handle", async () => {
    const fake = stub({
      [CATALOG]: [{ json: catalogBody() }],
      [IMAGE_SUBMIT]: [{ status: 202, json: submitted() }],
    });
    await run("image", PROMPT, "-m", "nano-banana-2.1", "--resolution", "2K", "--num-images", "2");
    const submit = fake.calls.find((c) => c.method === "POST");
    expect(submit?.body).toEqual({
      model: "nano-banana-2.1",
      prompt: PROMPT,
      resolution: "2K",
      num_images: 2,
    });
    expect(submit?.headers["idempotency-key"]).toMatch(/^multix-/);
    expect(stdout.slice(-4)).toEqual([
      `Job submitted: ${JOB_ID}`,
      `  Check:  multix sume status ${JOB_ID}`,
      `  Resume: multix sume status ${JOB_ID} --wait --download`,
      `  Cancel: multix sume cancel ${JOB_ID}`,
    ]);
    expect(text()).toContain("reserved $0.35");
    expectNoSecrets();
  });

  it("uploads a local image, waits and downloads the result", async () => {
    const input = path.join(tmp, "cat.png");
    fs.writeFileSync(input, PNG);
    const fake = stub({
      [CATALOG]: [{ json: catalogBody() }],
      "POST /v1/files/generate-upload-url": [
        {
          json: {
            data: {
              upload_url: UPLOAD_URL,
              public_url: PUBLIC_URL,
              upload_method: "PUT",
              upload_headers: { "Content-Type": "image/png" },
            },
          },
        },
      ],
      [`PUT ${UPLOAD_URL}`]: [{ status: 200, text: "" }],
      [IMAGE_SUBMIT]: [{ status: 202, json: submitted() }],
      [STATUS]: [{ json: status("completed") }],
      [RESULT]: [{ json: result() }],
      [`GET ${ARTIFACT_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    await run(
      "image",
      PROMPT,
      "-m",
      "nano-banana-2.1",
      "--image",
      input,
      "--idempotency-key",
      "my-key-1",
      "--wait",
    );
    const submit = fake.calls.find((c) => c.url.endsWith("/v1/image-router/generate"));
    expect(submit?.body).toMatchObject({ image_urls: [PUBLIC_URL] });
    expect(submit?.headers["idempotency-key"]).toBe("my-key-1");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.headers.authorization).toBeUndefined();
    const saved = path.join(tmp, "out", "sume-0f0e0d0c-01.png");
    expect(fs.readFileSync(saved)).toEqual(Buffer.from(PNG));
    expect(text()).toContain(saved);
    expect(text()).not.toContain("SIGNED_TOKEN_123");
    expectNoSecrets();
  });

  it("names the idempotency key when the submit outcome is unknown", async () => {
    stub({
      [CATALOG]: [{ json: catalogBody() }],
      [IMAGE_SUBMIT]: [{ status: 504, text: "gateway timeout", headers: { "retry-after": "0" } }],
    });
    const error = await run(
      "image",
      PROMPT,
      "-m",
      "nano-banana-2.1",
      "--idempotency-key",
      "k-9",
    ).catch((e) => e);
    expect(error.message).toMatch(/--idempotency-key "k-9".*app\.sume\.com/);
  });

  it("fails a failed job with Sume's reason and the refund note", async () => {
    stub({
      [CATALOG]: [{ json: catalogBody() }],
      [IMAGE_SUBMIT]: [{ status: 202, json: submitted() }],
      [STATUS]: [{ json: status("failed") }],
      [JOB]: [
        {
          json: {
            data: {
              job: {
                id: JOB_ID,
                status: "failed",
                error: { code: "content_policy_rejected", message: "Refused by the provider" },
              },
            },
          },
        },
      ],
    });
    const error = await run("image", PROMPT, "-m", "nano-banana-2.1", "--wait").catch((e) => e);
    expect(error).toBeInstanceOf(SumeJobError);
    expect(error.message).toMatch(
      /failed \[content_policy_rejected\]: Refused by the provider.*refunds/,
    );
  });

  it("falls back to a cached catalog when Sume's catalog cannot be read", async () => {
    stub({ [CATALOG]: [{ json: catalogBody() }] });
    await run("models");
    const fake = stub({
      [CATALOG]: [{ throws: new TypeError("fetch failed") }],
      [IMAGE_SUBMIT]: [{ status: 202, json: submitted() }],
    });
    await run("image", PROMPT, "-m", "nano-banana-2.1");
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(text()).toMatch(/checking flags against the cached copy/);
  });
});

describe("sume video", () => {
  it("submits a lip-sync job with two uploads-free URLs", async () => {
    const fake = stub({
      [CATALOG]: [{ json: catalogBody() }],
      [VIDEO_SUBMIT]: [{ status: 202, json: submitted() }],
    });
    await run(
      "video",
      "-m",
      "kling-avatar-2.0",
      "--image",
      "https://cdn.example.com/face.png",
      "--audio",
      "https://cdn.example.com/speech.mp3",
      "--duration",
      "12",
    );
    expect(fake.calls.find((c) => c.method === "POST")?.body).toEqual({
      model: "kling-avatar-2.0",
      duration: 12,
      image_url: "https://cdn.example.com/face.png",
      audio_url: "https://cdn.example.com/speech.mp3",
    });
  });
});

describe("sume status", () => {
  it("prints a JSON summary and a resume hint for a running job", async () => {
    stub({ [STATUS]: [{ json: status("processing", { queue_position: 3 }) }] });
    await run("status", JOB_ID);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      job_id: JOB_ID,
      status: "processing",
      terminal: false,
      result_ready: false,
      cancelable: false,
      queue_position: 3,
      next_poll_after_seconds: 2,
    });
    expect(text()).toContain(`Resume with: multix sume status ${JOB_ID} --wait --download`);
  });

  it("downloads a completed job, or prints its URLs with --no-download", async () => {
    stub({
      [STATUS]: [{ json: status("completed") }],
      [RESULT]: [{ json: result() }],
      [`GET ${ARTIFACT_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    const out = path.join(tmp, "fox.png");
    await run("status", JOB_ID, "--download", "--output", out);
    expect(fs.existsSync(out)).toBe(true);
    stdout.length = 0;
    await run("status", JOB_ID, "--no-download");
    expect(stdout).toEqual([ARTIFACT_URL]);
  });

  it("exits non-zero for a canceled job, with its summary", async () => {
    stub({
      [STATUS]: [{ json: status("canceled") }],
      [JOB]: [{ json: { data: { job: { id: JOB_ID, status: "canceled" } } } }],
    });
    const error = await run("status", JOB_ID).catch((e) => e);
    expect(error).toBeInstanceOf(SumeJobError);
    expect(JSON.parse(stdout.join("\n")).status).toBe("canceled");
  });

  it("refuses a bad job id", async () => {
    const fake = stub({});
    await expect(run("status", "job_../../x")).rejects.toThrow(/Invalid Sume job id/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("sume cancel", () => {
  it("cancels, and reports an already canceled job", async () => {
    stub({
      [CANCEL]: [
        {
          json: {
            data: { job_id: JOB_ID, status: "CANCELED", canceled: true, idempotency_hit: false },
          },
        },
        {
          json: {
            data: { job_id: JOB_ID, status: "CANCELED", canceled: true, idempotency_hit: true },
          },
        },
      ],
    });
    await run("cancel", JOB_ID);
    expect(text()).toMatch(/canceled; Sume refunds its reserved charge/);
    await run("cancel", JOB_ID);
    expect(text()).toMatch(/was already canceled/);
  });

  it.each([
    ["job_generation_already_started", /generation already started.*billed when it completes/],
    ["job_not_cancelable", /it already finished/],
  ])("explains 409 %s", async (code, message) => {
    stub({ [CANCEL]: [{ status: 409, json: sumeError(code, "no") }] });
    await expect(run("cancel", JOB_ID)).rejects.toThrow(message);
  });
});

describe("sume models", () => {
  it("lists one kind, with price and capabilities", async () => {
    stub({ [CATALOG]: [{ json: catalogBody() }] });
    await run("models", "--kind", "video");
    const listing = text();
    expect(listing).toMatch(/veo-3\.1 {2}\[video\]/);
    expect(listing).toMatch(/price: \$0\.20-\$0\.40 per second/);
    expect(listing).toMatch(/supports: text, audio, 4\/6\/8s, 720p\/1080p/);
    expect(listing).toMatch(
      /sume-remix-restyle {2}\[video\] \(special route; not supported by multix\)/,
    );
    expect(listing).not.toMatch(/nano-banana/);
  });

  it("prints JSON with its source, and the stale copy when offline", async () => {
    stub({ [CATALOG]: [{ json: catalogBody() }] });
    await run("models", "--json");
    const fresh = JSON.parse(stdout.join("\n"));
    expect(fresh.source).toMatchObject({ url: `${BASE}/v1/open/catalog`, state: "fresh" });
    expect(fresh.models).toHaveLength(8);
    stub({ [CATALOG]: [{ throws: new TypeError("fetch failed") }] });
    stdout.length = 0;
    await run("models", "--refresh", "--json");
    expect(JSON.parse(stdout.join("\n")).source.state).toBe("stale");
  });

  it("fails as unavailable with no cache and no network", async () => {
    stub({ [CATALOG]: [{ throws: new TypeError("fetch failed") }] });
    await expect(run("models")).rejects.toThrow(/Sume model catalog unavailable/);
  });
});

describe("sume estimate", () => {
  it("prints Sume's quote, labelled, without billing", async () => {
    const fake = stub({
      [CATALOG]: [{ json: catalogBody() }],
      "POST /v1/open/estimate": [{ json: { data: { usd: "1.60", credits: 160 } } }],
    });
    await run("estimate", "waves", "-m", "veo-3.1", "--duration", "4");
    expect(fake.calls.find((c) => c.method === "POST")?.body).toEqual({
      model: "veo-3.1",
      input: { prompt: "waves", duration: 4 },
    });
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      source: "sume",
      model: "veo-3.1",
      quote: { usd: "1.60", credits: 160 },
    });
    expect(text()).toMatch(
      /Sume's quote for veo-3\.1 \(from Sume, not billed; not used by --max-cost\)/,
    );
  });

  it("refuses local files (it uploads nothing)", async () => {
    stub({ [CATALOG]: [{ json: catalogBody() }] });
    await expect(run("estimate", "x", "-m", "seedance-2", "--image", "face.png")).rejects.toThrow(
      /takes https URLs, not local files/,
    );
  });
});
