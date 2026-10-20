import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ValidationError,
} from "../../../../src/core/errors.js";
import type { Logger } from "../../../../src/core/logger.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  type OmniRunOptions,
  checkOmniMedia,
  copyToOutput,
  findInteractionKey,
  interactionMaxBytes,
  runOmniVideo,
  saveOmniVideo,
} from "../../../../src/providers/gemini/omni-flow.js";

const MODEL = "gemini-omni-1.1-flash";
const API = "https://generativelanguage.googleapis.com/v1beta";
const KEY1 = "test-key-1";
const KEY2 = "test-key-2";
const VIDEO_URI = `${API}/files/vid123:download?alt=media`;
const VIDEO_BYTES = Buffer.from("fake-mp4-bytes");
const ID = "v1_abc123";

interface Call {
  method: string;
  url: string;
  key?: string;
  body?: Record<string, unknown>;
}

let tmp: string;
let outDir: string;
let calls: Call[];
let warnings: string[];
const savedEnv: Record<string, string | undefined> = {};

const logger: Logger = {
  info() {},
  success() {},
  warn(msg) {
    warnings.push(msg);
  },
  error() {},
  debug() {},
  header() {},
};

function stubFetch(route: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      key: new Headers(init.headers ?? {}).get("x-goog-api-key") ?? undefined,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const quota = () =>
  json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, 429);
const video = () => new Response(VIDEO_BYTES, { status: 200 });

const isSubmit = (c: Call) => c.method === "POST" && c.url === `${API}/interactions`;
const isPoll = (id: string) => (c: Call) =>
  c.method === "GET" && c.url === `${API}/interactions/${id}`;
const isFile = (name: string) => (c: Call) => c.method === "GET" && c.url === `${API}/${name}`;
const isDownload = (name: string) => (c: Call) =>
  c.method === "GET" && c.url === `${API}/${name}:download?alt=media`;

function completed(id = ID, uri: string | undefined = VIDEO_URI) {
  return {
    id,
    status: "completed",
    model: MODEL,
    steps: [
      { type: "user_input", content: [{ type: "text", text: "a cat" }] },
      { type: "thought", content: [{ type: "thought_signature", signature: "SIG_SECRET" }] },
      {
        type: "model_output",
        content: [{ type: "video", mime_type: "video/mp4", ...(uri ? { uri } : {}) }],
      },
    ],
    usage: {
      total_input_tokens: 10,
      total_output_tokens: 1000,
      output_tokens_by_modality: [{ modality: "video", tokens: 1000 }],
    },
  };
}

const ACTIVE_FILE = {
  name: "files/vid123",
  state: "ACTIVE",
  uri: VIDEO_URI,
  mimeType: "video/mp4",
};

const baseRequest = {
  model: MODEL,
  prompt: "a cat",
  aspectRatio: "16:9",
  resolution: "720p",
  durationSeconds: 5,
};

function runOpts(over: Partial<OmniRunOptions> = {}): OmniRunOptions {
  return { request: baseRequest, wait: true, waitTimeoutMs: 60_000, logger, ...over };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Drive a promise that waits on fake-timer sleeps. Each step advances the fake
 * clock and yields to real I/O, so stream downloads can finish too.
 */
async function settle<T>(p: Promise<T>): Promise<Outcome<T>> {
  let outcome: Outcome<T> | undefined;
  p.then(
    (value) => {
      outcome = { ok: true, value };
    },
    (error) => {
      outcome = { ok: false, error };
    },
  );
  for (let i = 0; outcome === undefined; i++) {
    if (i > 5000) throw new Error("flow did not settle");
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return outcome;
}

function errorOf(outcome: Outcome<unknown>): unknown {
  if (outcome.ok) throw new Error("expected the flow to fail, but it succeeded");
  return outcome.error;
}

function recordFiles(): string[] {
  return fs.readdirSync(outDir).filter((f) => f.startsWith("gemini_omni_") && f.endsWith(".json"));
}

function readRecordText(): string {
  const [file] = recordFiles();
  if (!file) throw new Error("no session record written");
  return fs.readFileSync(path.join(outDir, file), "utf8");
}

function readRecord(): Record<string, unknown> {
  return JSON.parse(readRecordText());
}

const postsWithKeys = () => calls.filter(isSubmit).map((c) => c.key);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-omni-flow-"));
  outDir = path.join(tmp, "out");
  calls = [];
  warnings = [];
  _resetGeminiKeyCooldowns();
  _resetOutputDir();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Mutate process.env in place and restore it afterwards.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = KEY1;
  process.env.MULTIX_OUTPUT_DIR = outDir;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "MULTIX_OUTPUT_DIR") {
      Reflect.deleteProperty(process.env, k);
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("runOmniVideo: generate, poll and save", () => {
  it("submits a string prompt as a stored background request, polls, and saves the video", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) return json(completed());
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(runOmniVideo(runOpts()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.interactionId).toBe(ID);
    expect(path.dirname(outcome.value.dest as string)).toBe(outDir);
    expect(fs.readFileSync(outcome.value.dest as string)).toEqual(VIDEO_BYTES);

    const submit = calls.find(isSubmit);
    expect(submit?.body).toEqual({
      model: MODEL,
      input: "a cat",
      response_format: {
        type: "video",
        delivery: "uri",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: "5s",
      },
      store: true,
      background: true,
    });
    // One key for the whole flow.
    expect(calls.every((c) => c.key === KEY1)).toBe(true);
  });

  it("writes the session record before polling, with no key value or file URI", async () => {
    let recordDuringPoll = "";
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) {
        recordDuringPoll ||= readRecordText();
        return json(completed());
      }
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(runOmniVideo(runOpts()));
    expect(outcome.ok).toBe(true);

    const early = JSON.parse(recordDuringPoll);
    expect(early).toMatchObject({
      provider: "gemini",
      interaction_id: ID,
      model: MODEL,
      key_alias: "GEMINI_API_KEY",
      status: "in_progress",
      store: true,
    });

    const final = readRecord();
    expect(final).toMatchObject({
      status: "completed",
      media_file: "files/vid123",
      output_path: path.join(outDir, `${path.basename(final.output_path as string)}`),
    });
    expect(final.usage).toEqual(completed().usage);
    expect(final.cost_estimate).toMatchObject({ usd: expect.any(Number) });

    for (const text of [readRecordText(), recordDuringPoll]) {
      expect(text).not.toContain(KEY1);
      expect(text).not.toContain("generativelanguage");
      expect(text).not.toContain("SIG_SECRET");
    }
  });

  it("rotates to the second key only on a quota response at submit, then polls and downloads with that key", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    let polls = 0;
    stubFetch((c) => {
      if (isSubmit(c)) {
        return c.key === KEY1 ? quota() : json({ id: ID, status: "in_progress" });
      }
      if (isPoll(ID)(c)) {
        polls++;
        return polls === 1 ? json({ id: ID, status: "queued" }) : json(completed());
      }
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(runOmniVideo(runOpts()));
    expect(outcome.ok).toBe(true);

    expect(postsWithKeys()).toEqual([KEY1, KEY2]);
    const afterSubmit = calls.slice(calls.findIndex((c) => isSubmit(c) && c.key === KEY2) + 1);
    expect(afterSubmit.length).toBeGreaterThan(0);
    expect(afterSubmit.every((c) => c.key === KEY2)).toBe(true);
    expect(warnings).toContain("GEMINI_API_KEY is rate-limited; retrying with GEMINI_API_KEY_2");
    expect(readRecord().key_alias).toBe("GEMINI_API_KEY_2");
  });

  it("does not rotate keys on a non-quota submit rejection", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch(() =>
      json(
        { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid model name" } },
        400,
      ),
    );

    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).toContain("Invalid model name");
    expect(postsWithKeys()).toEqual([KEY1]);
  });

  it("adds the EEA, Switzerland and UK hint when a submit is refused by region", async () => {
    stubFetch(() =>
      json({ error: { message: "Editing uploaded video is not available in your region" } }, 400),
    );
    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect((error as Error).message).toMatch(/EEA, Switzerland and the UK/);
  });

  it("does not retry a submit that fails on the network, since the video may already be billed", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch((c) => {
      if (isSubmit(c)) throw new TypeError("fetch failed");
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/not retried/);
    expect((error as Error).message).toMatch(/billed/);
    expect(postsWithKeys()).toEqual([KEY1]);
    expect(calls).toHaveLength(1);
  });

  it("throws the failure message and records it for a failed interaction, without downloading", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) {
        return json({ id: ID, status: "failed", error: { message: "content policy violation" } });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("failed");
    expect((error as Error).message).toContain("content policy violation");
    expect(readRecord()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("content policy"),
    });
    expect(calls.some((c) => c.url.includes("/files/"))).toBe(false);
  });

  it("fails a completed interaction that has no video and quotes the model's text", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) {
        return json({
          id: ID,
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "I cannot make that video." }],
            },
          ],
        });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect((error as Error).message).toContain("completed without a video");
    expect((error as Error).message).toContain("I cannot make that video.");
  });

  it("keeps the record and points at video-status when the wait times out", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) return json({ id: ID, status: "in_progress" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(await settle(runOmniVideo(runOpts({ waitTimeoutMs: 10_000 }))));
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect((error as Error).message).toContain("gemini video-status v1_abc123 --download");
    expect(readRecord()).toMatchObject({ interaction_id: ID, status: "in_progress" });
  });

  it("stops at once, without polling again, when the final GET is over the size cap", async () => {
    let polls = 0;
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) {
        polls++;
        // An inline video larger than the base64 size of MULTIX_MAX_DOWNLOAD_MB.
        return new Response("{}", {
          status: 200,
          headers: { "content-length": String(interactionMaxBytes() + 1) },
        });
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("MULTIX_MAX_DOWNLOAD_MB");
    expect((error as Error).message).toContain("gemini video-status v1_abc123 --download");
    expect(polls).toBe(1);
    expect(readRecord()).toMatchObject({ interaction_id: ID });
  });

  it("caps an Interaction read at the base64 size of MULTIX_MAX_DOWNLOAD_MB plus JSON room", () => {
    process.env.MULTIX_MAX_DOWNLOAD_MB = "3";
    try {
      expect(interactionMaxBytes()).toBe(4 * 1024 * 1024 + 64 * 1024 * 1024);
    } finally {
      Reflect.deleteProperty(process.env, "MULTIX_MAX_DOWNLOAD_MB");
    }
  });

  it("polls only for the part of --wait-timeout the submit left over", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) {
        vi.setSystemTime(Date.now() + 50_000);
        return json({ id: ID, status: "in_progress" });
      }
      if (isPoll(ID)(c)) return json({ id: ID, status: "in_progress" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const started = Date.now();
    const error = errorOf(await settle(runOmniVideo(runOpts({ waitTimeoutMs: 60_000 }))));
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(Date.now() - started).toBeLessThanOrEqual(62_000);
  });

  it("submits nothing when --wait-timeout runs out during the upload", async () => {
    const clip = path.join(tmp, "clip.mp4");
    fs.writeFileSync(clip, "video-bytes");
    stubFetch((c) => {
      if (c.url === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
        return new Response("", {
          status: 200,
          headers: {
            "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session/1",
          },
        });
      }
      if (c.url.startsWith("https://generativelanguage.googleapis.com/upload/session")) {
        vi.setSystemTime(Date.now() + 61_000);
        return new Response(
          JSON.stringify({
            file: {
              name: "files/src1",
              uri: `${API}/files/src1`,
              state: "ACTIVE",
              mimeType: "video/mp4",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-goog-upload-status": "final" },
          },
        );
      }
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(
      await settle(
        runOmniVideo(
          runOpts({
            request: { ...baseRequest, task: "edit" },
            videoPath: clip,
            waitTimeoutMs: 60_000,
          }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("nothing was submitted");
    expect(calls.filter(isSubmit)).toHaveLength(0);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("keeps polling through a transient 503 from the status endpoint", async () => {
    let polls = 0;
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) {
        polls++;
        return polls === 1 ? json({ error: "unavailable" }, 503) : json(completed());
      }
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(runOmniVideo(runOpts()));
    expect(outcome.ok).toBe(true);
    expect(polls).toBe(2);
  });

  it("returns the id and leaves the record in progress with --no-wait", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(runOmniVideo(runOpts({ wait: false })));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.interactionId).toBe(ID);
    expect(outcome.value.dest).toBeUndefined();
    expect(readRecord()).toMatchObject({ interaction_id: ID, status: "in_progress" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("refuses --no-store with --no-wait before sending anything", async () => {
    stubFetch(() => {
      throw new Error("no request expected");
    });
    const error = errorOf(
      await settle(
        runOmniVideo(runOpts({ request: { ...baseRequest, store: false }, wait: false })),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/needs a stored interaction/);
    expect(calls).toHaveLength(0);
  });

  it("runs --no-store as one synchronous request with inline delivery, no id, and no polling", async () => {
    const inlineResponse = {
      status: "completed",
      steps: [
        { type: "thought", content: [{ type: "thought_signature", signature: "SIG_SECRET" }] },
        {
          type: "model_output",
          content: [
            { type: "video", mime_type: "video/mp4", data: VIDEO_BYTES.toString("base64") },
          ],
        },
      ],
      usage: {
        total_output_tokens: 1000,
        output_tokens_by_modality: [{ modality: "video", tokens: 1000 }],
      },
    };
    stubFetch((c) => {
      if (isSubmit(c)) return json(inlineResponse);
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(
      runOmniVideo(runOpts({ request: { ...baseRequest, store: false } })),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.interactionId).toBeUndefined();
    expect(fs.readFileSync(outcome.value.dest as string)).toEqual(VIDEO_BYTES);

    const submit = calls.find(isSubmit);
    expect(submit?.body).toMatchObject({
      store: false,
      background: false,
      response_format: { delivery: "inline" },
    });
    expect(calls).toHaveLength(1);
    const record = readRecord();
    expect(record).not.toHaveProperty("interaction_id");
    expect(record).toMatchObject({ store: false, status: "completed" });
    expect(readRecordText()).not.toContain("SIG_SECRET");
    expect(warnings.some((w) => w.includes("--no-store"))).toBe(true);
  });

  it("fails an unstored request that did not finish, since there is nothing to poll", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ status: "in_progress", steps: [] });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });
    const error = errorOf(
      await settle(runOmniVideo(runOpts({ request: { ...baseRequest, store: false } }))),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(/returned no finished video/);
    expect(calls).toHaveLength(1);
  });

  it("fails a stored request that returns no interaction id", async () => {
    stubFetch((c) => {
      if (isSubmit(c)) return json({ status: "in_progress" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });
    const error = errorOf(await settle(runOmniVideo(runOpts())));
    expect((error as Error).message).toMatch(/returned no interaction id/);
    expect(calls).toHaveLength(1);
  });

  it("sends reference images inline before the prompt", async () => {
    const png = path.join(tmp, "frame.png");
    fs.writeFileSync(png, Buffer.from("89504e47", "hex"));
    stubFetch((c) => {
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) return json(completed());
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    await settle(runOmniVideo(runOpts({ imagePaths: [png] })));
    expect(calls.find(isSubmit)?.body?.input).toEqual([
      {
        type: "image",
        data: Buffer.from("89504e47", "hex").toString("base64"),
        mime_type: "image/png",
      },
      { type: "text", text: "a cat" },
    ]);
  });

  it("rejects missing or unsupported local media before any request", async () => {
    stubFetch(() => {
      throw new Error("no request expected");
    });
    const txt = path.join(tmp, "notes.txt");
    fs.writeFileSync(txt, "hi");

    const missing = errorOf(
      await settle(runOmniVideo(runOpts({ imagePaths: [path.join(tmp, "nope.png")] }))),
    );
    expect((missing as Error).message).toMatch(/Image not found/);
    const wrongType = errorOf(await settle(runOmniVideo(runOpts({ imagePaths: [txt] }))));
    expect((wrongType as Error).message).toMatch(/accepts PNG/);
    expect(calls).toHaveLength(0);
  });
});

describe("runOmniVideo: follow-up turns", () => {
  it("looks the parent up across keys and submits the follow-up with the parent's key", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    const parent = "v1_parent1";
    stubFetch((c) => {
      if (isPoll(parent)(c)) {
        return c.key === KEY1
          ? json({ error: { message: "not found" } }, 404)
          : json(completed(parent));
      }
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) return json(completed());
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(
      runOmniVideo(
        runOpts({
          request: { ...baseRequest, task: "edit", previousInteractionId: parent },
        }),
      ),
    );
    expect(outcome.ok).toBe(true);
    const submit = calls.find(isSubmit);
    expect(submit?.key).toBe(KEY2);
    expect(submit?.body?.previous_interaction_id).toBe(parent);
    // The API rejects a video task beside previous_interaction_id.
    expect(submit?.body).not.toHaveProperty("generation_config");
    expect(
      calls.filter((c) => c.url.endsWith(`/interactions/${ID}`)).every((c) => c.key === KEY2),
    ).toBe(true);
    expect(readRecord()).toMatchObject({
      parent_interaction_id: parent,
      key_alias: "GEMINI_API_KEY_2",
    });
  });

  it("refuses a parent that is not completed, before submitting", async () => {
    stubFetch((c) => {
      if (isPoll("v1_busy")(c)) return json({ id: "v1_busy", status: "in_progress" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const error = errorOf(
      await settle(
        runOmniVideo(
          runOpts({ request: { ...baseRequest, task: "edit", previousInteractionId: "v1_busy" } }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/only a completed interaction/);
    expect(calls.some(isSubmit)).toBe(false);
  });

  it("sends uploaded source video through the Files API and never takes it for the result", async () => {
    const clip = path.join(tmp, "clip.mp4");
    fs.writeFileSync(clip, "video-bytes");
    const sourceUri = `${API}/files/src999`;
    stubFetch((c) => {
      if (
        c.method === "POST" &&
        c.url === "https://generativelanguage.googleapis.com/upload/v1beta/files"
      ) {
        return new Response("", {
          status: 200,
          headers: {
            "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session/1",
          },
        });
      }
      if (
        c.method === "POST" &&
        c.url.startsWith("https://generativelanguage.googleapis.com/upload/session")
      ) {
        return new Response(
          JSON.stringify({
            file: { name: "files/src999", uri: sourceUri, state: "ACTIVE", mimeType: "video/mp4" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-goog-upload-status": "final" },
          },
        );
      }
      if (isSubmit(c)) return json({ id: ID, status: "in_progress" });
      if (isPoll(ID)(c)) return json(completed());
      if (isFile("files/vid123")(c)) return json(ACTIVE_FILE);
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });

    const outcome = await settle(
      runOmniVideo(runOpts({ request: { ...baseRequest, task: "edit" }, videoPath: clip })),
    );
    expect(outcome.ok).toBe(true);
    expect(calls.find(isSubmit)?.body?.input).toEqual([
      { type: "video", uri: sourceUri, mime_type: "video/mp4" },
      { type: "text", text: "a cat" },
    ]);
    expect(readRecord().media_file).toBe("files/vid123");
  });
});

describe("saving the generated video", () => {
  const interaction = (uri: string) => ({
    id: ID,
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri }] }],
  });

  it("fails without downloading when the file state is FAILED", async () => {
    stubFetch((c) => {
      if (isFile("files/vid123")(c)) return json({ ...ACTIVE_FILE, state: "FAILED" });
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });
    const dest = path.join(tmp, "out.mp4");
    const error = errorOf(await settle(saveOmniVideo(interaction(VIDEO_URI), KEY1, dest, logger)));
    expect((error as Error).message).toMatch(/files\/vid123 is FAILED/);
    expect(calls.some((c) => c.url.endsWith(":download?alt=media"))).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("waits while the file is PROCESSING, then downloads it with the same key", async () => {
    let fileReads = 0;
    stubFetch((c) => {
      if (isFile("files/vid123")(c)) {
        fileReads++;
        return json({ ...ACTIVE_FILE, state: fileReads === 1 ? "PROCESSING" : "ACTIVE" });
      }
      if (isDownload("files/vid123")(c)) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });
    const dest = path.join(tmp, "nested", "out.mp4");
    const outcome = await settle(saveOmniVideo(interaction(VIDEO_URI), KEY2, dest, logger));
    expect(outcome.ok).toBe(true);
    expect(fileReads).toBe(2);
    expect(calls.filter((c) => c.url.includes("/files/")).every((c) => c.key === KEY2)).toBe(true);
    expect(fs.readFileSync(dest)).toEqual(VIDEO_BYTES);
  });

  it("never sends the key to a video URI on another host, and does not ask Files API about it", async () => {
    const foreign = "https://storage.example.com/clip.mp4";
    stubFetch((c) => {
      if (c.url === foreign) return video();
      throw new Error(`unexpected ${c.method} ${c.url}`);
    });
    const dest = path.join(tmp, "foreign.mp4");
    const outcome = await settle(saveOmniVideo(interaction(foreign), KEY1, dest, logger));
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBeUndefined();
    expect(fs.readFileSync(dest)).toEqual(VIDEO_BYTES);
  });

  it("refuses a non-https video URI without downloading it", async () => {
    stubFetch(() => {
      throw new Error("no request expected");
    });
    const error = errorOf(
      await settle(
        saveOmniVideo(
          interaction("http://storage.example.com/clip.mp4"),
          KEY1,
          path.join(tmp, "x.mp4"),
          logger,
        ),
      ),
    );
    expect((error as Error).message).toMatch(/non-https video URI/);
    expect(calls).toHaveLength(0);
  });

  it("decodes inline base64 video without any network call", async () => {
    stubFetch(() => {
      throw new Error("no request expected");
    });
    const dest = path.join(tmp, "inline.mp4");
    const inline = {
      id: ID,
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            { type: "video", mime_type: "video/mp4", data: VIDEO_BYTES.toString("base64") },
          ],
        },
      ],
    };
    const outcome = await settle(saveOmniVideo(inline, KEY1, dest, logger));
    expect(outcome).toMatchObject({ ok: true, value: { bytes: VIDEO_BYTES.length } });
    expect(fs.readFileSync(dest)).toEqual(VIDEO_BYTES);
    expect(calls).toHaveLength(0);
  });

  it("copies the saved video to --output, creating its directory", () => {
    const src = path.join(tmp, "src.mp4");
    fs.writeFileSync(src, VIDEO_BYTES);
    const target = path.join(tmp, "copies", "deep", "out.mp4");
    copyToOutput(src, target, logger);
    expect(fs.readFileSync(target)).toEqual(VIDEO_BYTES);
    expect(() => copyToOutput(src, undefined, logger)).not.toThrow();
  });
});

describe("findInteractionKey", () => {
  it("returns the first key whose project can read the interaction", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch((c) =>
      c.key === KEY1 ? json({ error: { message: "forbidden" } }, 403) : json(completed(ID)),
    );
    const found = await findInteractionKey(ID, logger);
    expect(found).toMatchObject({ apiKey: KEY2, keyName: "GEMINI_API_KEY_2" });
    expect(found.interaction.status).toBe("completed");
  });

  it("reports a ProviderError naming the last HTTP status when no key can read it", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch(() => json({ error: { message: "not found" } }, 404));
    const error = await findInteractionKey(ID, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toMatch(
      /not found for any configured Gemini key \(HTTP 404\)/,
    );
    expect(calls.map((c) => c.key)).toEqual([KEY1, KEY2]);
  });

  it("does not skip a server error, so the caller sees it", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    const error = await findInteractionKey(ID, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("fails clearly with no key configured", async () => {
    Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
    stubFetch(() => {
      throw new Error("no request expected");
    });
    const error = await findInteractionKey(ID, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/GEMINI_API_KEY is not set/);
  });

  it("rejects an unsafe interaction id before reading any key", async () => {
    stubFetch(() => {
      throw new Error("no request expected");
    });
    await expect(findInteractionKey("../files/x", logger)).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("checkOmniMedia", () => {
  it("accepts Omni image types and video files", () => {
    const png = path.join(tmp, "a.png");
    const clip = path.join(tmp, "b.mp4");
    fs.writeFileSync(png, "x");
    fs.writeFileSync(clip, "x");
    expect(() => checkOmniMedia({ imagePaths: [png], videoPath: clip })).not.toThrow();
  });

  it("rejects URLs, missing files, non-image types and non-video files", () => {
    const txt = path.join(tmp, "notes.txt");
    const png = path.join(tmp, "a.png");
    fs.writeFileSync(txt, "x");
    fs.writeFileSync(png, "x");
    expect(() => checkOmniMedia({ imagePaths: ["https://example.com/a.png"] })).toThrow(
      /local file, not a URL/,
    );
    expect(() => checkOmniMedia({ imagePaths: [path.join(tmp, "missing.png")] })).toThrow(
      /Image not found/,
    );
    expect(() => checkOmniMedia({ imagePaths: [txt] })).toThrow(ValidationError);
    expect(() => checkOmniMedia({ videoPath: txt })).toThrow(/Not a video file/);
    expect(() => checkOmniMedia({ videoPath: path.join(tmp, "missing.mp4") })).toThrow(
      /Video not found/,
    );
  });
});
