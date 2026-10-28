/**
 * Sume commands driven through commander with the real env-based client
 * (global fetch stubbed with the fake Sume API and the trimmed live
 * catalogue): request building, catalogue validation before any paid
 * request, the no-wait job handle, wait + download, failed and canceled
 * jobs, the poll-timeout resume hint, the ambiguous-submit hint, models,
 * cancel and upload. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerSumeCommands } from "../../../../src/providers/sume/commands/index.js";
import { SumeJobFailedError, SumeSubmitError } from "../../../../src/providers/sume/errors.js";
import {
  ARTIFACT_URL,
  BASE,
  CATALOG,
  CATALOG_URL,
  JOB_ID,
  KEY,
  UPLOAD_URL,
  apiError,
  createFakeSume,
  result,
  status,
  submitted,
} from "./fake-sume.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const IMAGE = "POST /v1/image-router/generate";
const VIDEO = "POST /v1/video-router/generate";
const STATUS = `GET /v1/jobs/${JOB_ID}/status`;
const RESULT = `GET /v1/jobs/${JOB_ID}/result`;
const JOB = `GET /v1/jobs/${JOB_ID}`;
const CATALOG_ROUTE = { [`GET ${CATALOG_URL}`]: [{ json: CATALOG }] };

let tmp: string;
let output: string[];
/** console.log only: what a pipe (`| jq`) would read. */
let stdout: string[];
let savedArgv: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-sume-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("MULTIX_CACHE_DIR", path.join(tmp, "cache"));
  vi.stubEnv("SUME_API_KEY", KEY);
  vi.stubEnv("SUME_BASE_URL", BASE);
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  savedArgv = runState.argv;
  runState.argv = [];
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
  runState.argv = savedArgv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeSume>[0]) {
  const fake = createFakeSume({ ...CATALOG_ROUTE, ...routes });
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

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const text = () => output.join("\n");
const generateCalls = (fake: ReturnType<typeof stub>) =>
  fake.calls.filter((c) => /router\/generate$/.test(c.url));

describe("sume image", () => {
  it("builds the request, submits once with a fresh key and prints the job handle", async () => {
    const fake = stub({ [IMAGE]: [{ status: 202, json: submitted() }] });
    await run(
      "image",
      "a red cup",
      "-m",
      "gpt-image-2",
      "--aspect-ratio",
      "16:9",
      "--quality",
      "high",
      "--num-images",
      "2",
      "--image",
      "https://example.com/ref.png",
      "--input",
      '{"output_format":"png"}',
    );
    const [call] = generateCalls(fake);
    expect(call?.body).toEqual({
      model: "gpt-image-2",
      prompt: "a red cup",
      aspect_ratio: "16:9",
      quality: "high",
      num_images: 2,
      image_urls: ["https://example.com/ref.png"],
      output_format: "png",
    });
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(stdout).toEqual([
      `Job submitted: ${JOB_ID}`,
      `  Check:  multix sume status ${JOB_ID}`,
      `  Resume: multix sume status ${JOB_ID} --wait --download`,
      `  Cancel: multix sume cancel ${JOB_ID}`,
    ]);
    expect(text()).toContain("charged $0.79");
    expect(text()).not.toContain(KEY);
  });

  it("uses a fresh key per invocation and reuses --idempotency-key", async () => {
    const fake = stub({ [IMAGE]: [{ status: 202, json: submitted() }] });
    await run("image", "a", "-m", "gpt-image-2");
    await run("image", "a", "-m", "gpt-image-2");
    await run("image", "a", "-m", "gpt-image-2", "--idempotency-key", "my-key-1");
    const keys = generateCalls(fake).map((c) => c.headers["idempotency-key"]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe("my-key-1");
  });

  it("logs an idempotency hit without a new charge", async () => {
    stub({ [IMAGE]: [{ json: submitted({ idempotency_hit: true }) }] });
    await run("image", "a", "-m", "gpt-image-2", "--idempotency-key", "k1");
    expect(text()).toContain("idempotency_hit: true");
    expect(text()).not.toContain("charged $0.79");
  });

  it.each([
    [["image", "a"], /Missing -m\/--model/],
    [["image", "a", "-m", "nope-1"], /Unknown Sume model "nope-1".*multix sume models/],
    [["image", "a", "-m", "kling-4"], /kling-4 is a video model; run it with multix sume video/],
    [
      ["image", "a", "-m", "gpt-image-2", "--aspect-ratio", "7:3"],
      /aspect_ratio.*"7:3".*use one of/,
    ],
    [["image", "a", "-m", "gpt-image-2", "--num-images", "9"], /at most 4/],
    [
      ["image", "a", "-m", "recraft-v4", "--image", "https://example.com/a.png"],
      /does not edit images/,
    ],
    [["image", "a", "-m", "qwen-image-layered"], /requires .*image_urls/],
    [["image", "a", "-m", "gpt-image-2", "--input", '{"model":"x"}'], /may not set "model"/],
    [
      ["image", "a", "-m", "gpt-image-2", "--quality", "high", "--input", '{"quality":"low"}'],
      /set by both --quality and --input/,
    ],
    [["image", "a", "-m", "gpt-image-2", "--image", "http://example.com/a.png"], /https/],
    [["image", "a", "-m", "gpt-image-2", "--output", "x.png"], /need --wait/],
  ])("rejects %j before any paid request", async (args, message) => {
    const fake = stub({});
    const error = await failure(run(...args));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(message);
    expect(generateCalls(fake)).toHaveLength(0);
  });

  it("waits, downloads the image and lists the saved file on stdout", async () => {
    stub({
      [IMAGE]: [{ status: 202, json: submitted() }],
      [STATUS]: [
        {
          json: status("completed", {
            job: {
              id: JOB_ID,
              status: "completed",
              usage_summary: { status: "captured", captured_usd_cents: 79, final: true },
            },
          }),
        },
      ],
      [RESULT]: [{ json: result() }],
      [`GET ${ARTIFACT_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    await run("image", "a", "-m", "gpt-image-2", "--wait", "--image-format", "original");
    const file = path.join(tmp, "out", "sume-0f0e0d0c-01.png");
    expect(fs.readFileSync(file)).toEqual(Buffer.from(PNG));
    expect(stdout.join("\n")).toContain(file);
    expect(stdout.join("\n")).not.toContain("SIGNED_TOKEN_123");
    expect(text()).toContain("Charged: $0.79");
  });

  it("prints the safe retry command after an ambiguous submit failure", async () => {
    runState.argv = ["sume", "image", "a cup", "-m", "gpt-image-2", "--idempotency-key", "k-old"];
    stub({ [IMAGE]: [{ status: 500, text: "Internal Server Error" }] });
    const error = await failure(
      run("image", "a cup", "-m", "gpt-image-2", "--idempotency-key", "k-old"),
    );
    expect(error).toBeInstanceOf(SumeSubmitError);
    expect(error.message).toContain("Do not resubmit without the same idempotency key (k-old)");
    expect(error.message).toContain(
      "multix sume image 'a cup' -m gpt-image-2 --idempotency-key k-old",
    );
  });

  it("uploads a local --image before submitting", async () => {
    const local = path.join(tmp, "cup.png");
    fs.writeFileSync(local, PNG);
    const fake = stub({
      "POST /v1/files/generate-upload-url": [
        {
          status: 201,
          json: {
            data: {
              public_url: "https://media.sume.test/u/cup.png",
              upload_url: UPLOAD_URL,
              upload_method: "PUT",
              upload_headers: { "content-type": "image/png" },
            },
          },
        },
      ],
      [`PUT ${UPLOAD_URL}`]: [{ text: "" }],
      [IMAGE]: [{ status: 202, json: submitted() }],
    });
    await run("image", "edit it", "-m", "gpt-image-2", "--image", local);
    expect(generateCalls(fake)[0]?.body).toMatchObject({
      image_urls: ["https://media.sume.test/u/cup.png"],
    });
    expect(fake.calls.find((c) => c.method === "PUT")?.headers.authorization).toBeUndefined();
    expect(text()).not.toContain("SIGNED_PUT_456");
  });
});

describe("sume video", () => {
  it("builds a video request with typed fields", async () => {
    const fake = stub({ [VIDEO]: [{ status: 202, json: submitted() }] });
    await run(
      "video",
      "waves",
      "-m",
      "kling-4",
      "--image",
      "https://example.com/first.png",
      "--end-image",
      "https://example.com/last.png",
      "--duration",
      "5",
      "--resolution",
      "1080p",
      "--no-generate-audio",
    );
    expect(generateCalls(fake)[0]?.body).toEqual({
      model: "kling-4",
      prompt: "waves",
      image_url: "https://example.com/first.png",
      end_image_url: "https://example.com/last.png",
      duration: 5,
      resolution: "1080p",
      generate_audio: false,
    });
  });

  it.each([
    [["video", "x", "-m", "veo-3.1", "--duration", "5"], /one of 4, 6, 8/],
    [["video", "x", "-m", "grok-imagine-video-1.5"], /from text alone/],
    [["video", "x", "-m", "sume-remix-restyle"], /not a router model/],
    [["video", "x", "-m", "gpt-image-2"], /image model; run it with multix sume image/],
    [
      [
        "video",
        "hi",
        "-m",
        "veed-fabric-1.0",
        "--image",
        "https://example.com/a.png",
        "--audio",
        "https://example.com/a.mp3",
        "--duration",
        "10",
      ],
      /does not take.*prompt/,
    ],
  ])("rejects %j before any paid request", async (args, message) => {
    const fake = stub({});
    const error = await failure(run(...args));
    expect(error.message).toMatch(message);
    expect(generateCalls(fake)).toHaveLength(0);
  });

  it("fails a failed job with the reason and the refund note", async () => {
    stub({
      [VIDEO]: [{ status: 202, json: submitted() }],
      [STATUS]: [{ json: status("failed") }],
      [JOB]: [
        {
          json: {
            data: {
              job: {
                id: JOB_ID,
                status: "failed",
                error: { code: "content_policy", message: "blocked by policy" },
                usage_summary: { status: "refunded", refunded_usd_cents: 79, final: true },
              },
            },
          },
        },
      ],
    });
    const error = await failure(run("video", "waves", "-m", "kling-4", "--wait"));
    expect(error).toBeInstanceOf(SumeJobFailedError);
    expect(error.message).toContain("failed [content_policy]: blocked by policy");
    expect(error.message).toContain("was not charged");
    expect(text()).toContain("Refunded: $0.79");
  });

  it("times out with the resume command", async () => {
    stub({
      [VIDEO]: [{ status: 202, json: submitted() }],
      [STATUS]: [{ json: status("processing") }],
    });
    const error = await failure(
      run("video", "waves", "-m", "kling-4", "--wait", "--wait-timeout", "1"),
    );
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toContain(`Resume with: multix sume status ${JOB_ID} --wait --download`);
  });
});

describe("sume status and cancel", () => {
  it("prints a running job as JSON with a resume hint on stderr", async () => {
    stub({ [STATUS]: [{ json: status("processing", { queue_position: 2 }) }] });
    await run("status", JOB_ID);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      id: JOB_ID,
      status: "processing",
      queue_position: 2,
    });
    expect(text()).toContain("Resume with");
  });

  it("exits non-zero for a canceled job and still prints its JSON", async () => {
    stub({
      [STATUS]: [
        {
          json: status("canceled", {
            job: {
              id: JOB_ID,
              status: "canceled",
              error: { code: "canceled", message: "canceled by user" },
              usage_summary: { refunded_usd_cents: 120, final: true },
            },
          }),
        },
      ],
    });
    const error = await failure(run("status", JOB_ID));
    expect(error).toBeInstanceOf(SumeJobFailedError);
    expect(error.message).toContain("canceled");
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "canceled" });
    expect(text()).toContain("Refunded: $1.20");
  });

  it("lists a completed job's artifacts without downloading by default", async () => {
    stub({ [STATUS]: [{ json: status("completed") }], [RESULT]: [{ json: result() }] });
    await run("status", JOB_ID);
    const printed = stdout.join("\n");
    expect(JSON.parse(printed)).toMatchObject({ id: JOB_ID, status: "completed" });
    expect(printed).not.toContain("SIGNED_TOKEN_123");
  });

  it("rejects a malformed job id without a request", async () => {
    const fake = stub({});
    await expect(run("status", "job_../../x")).rejects.toBeInstanceOf(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });

  it("cancels a queued job", async () => {
    const fake = stub({
      [`POST /v1/jobs/${JOB_ID}/cancel`]: [
        { json: { data: { canceled: true, idempotency_hit: false, status: "canceled" } } },
      ],
    });
    await run("cancel", JOB_ID);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ jobId: JOB_ID, canceled: true });
    expect(fake.calls[0]?.body).toEqual({});
    expect(text()).toContain("refunds canceled jobs");
  });

  it("explains a cancel that came too late", async () => {
    stub({
      [`POST /v1/jobs/${JOB_ID}/cancel`]: [
        { status: 409, json: apiError("job_generation_already_started") },
      ],
    });
    const error = await failure(run("cancel", JOB_ID));
    expect(error.message).toContain("will finish and be charged");
  });
});

describe("sume models and upload", () => {
  it("lists the catalogue as JSON filtered by kind, without a key", async () => {
    vi.stubEnv("SUME_API_KEY", "");
    const fake = stub({});
    await run("models", "--kind", "lipsync", "--json");
    const parsed = JSON.parse(stdout.join("\n")) as {
      source: { state: string; url: string };
      models: { id: string }[];
    };
    expect(parsed.source).toMatchObject({ state: "fresh", url: CATALOG_URL });
    expect(parsed.models.map((m) => m.id)).toEqual(["veed-fabric-1.0", "sync-lipsync-3"]);
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("marks route-only models as not runnable in text output", async () => {
    stub({});
    await run("models", "--kind", "video");
    expect(text()).toContain("own endpoint (not run by multix sume)");
    expect(text()).toContain("kling-4");
  });

  it("rejects an unknown --kind", async () => {
    stub({});
    await expect(run("models", "--kind", "audio")).rejects.toBeInstanceOf(ValidationError);
  });

  it("uploads a file and prints only its public URL", async () => {
    const local = path.join(tmp, "voice.mp3");
    fs.writeFileSync(local, new Uint8Array([1, 2, 3]));
    stub({
      "POST /v1/files/generate-upload-url": [
        {
          status: 201,
          json: {
            data: {
              public_url: "https://media.sume.test/u/voice.mp3",
              upload_url: UPLOAD_URL,
              upload_method: "PUT",
              upload_headers: { "content-type": "audio/mpeg" },
            },
          },
        },
      ],
      [`PUT ${UPLOAD_URL}`]: [{ text: "" }],
    });
    await run("upload", local);
    expect(stdout).toEqual(["https://media.sume.test/u/voice.mp3"]);
  });

  it("asks for the key when it is missing", async () => {
    vi.stubEnv("SUME_API_KEY", "");
    stub({});
    await expect(run("status", JOB_ID)).rejects.toThrow(/SUME_API_KEY is not set/);
  });
});
