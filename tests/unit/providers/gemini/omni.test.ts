import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { createLogger } from "../../../../src/core/logger.js";
import { resolveFollowUpSource } from "../../../../src/providers/gemini/commands/omni-follow-up.js";
import {
  _resetGeminiKeyCooldowns,
  withNamedGeminiKey,
} from "../../../../src/providers/gemini/key-pool.js";
import {
  GEMINI_OMNI_MODEL_DEFAULT,
  getDefaultModel,
  videoModelDeprecation,
  videoModelFamily,
} from "../../../../src/providers/gemini/models.js";
import {
  type OmniSessionRecord,
  omniSettings,
  runOmni,
  sessionPathFor,
  writeSessionRecord,
} from "../../../../src/providers/gemini/omni-run.js";
import {
  buildOmniRequest,
  extractOmniVideo,
  geminiFileName,
} from "../../../../src/providers/gemini/omni.js";

const logger = createLogger({ verbose: false });
const KEY = "test-gemini-key-0000";
const KEY2 = "test-gemini-key-2222";
const API = "https://generativelanguage.googleapis.com/v1beta";
const MP4 = Buffer.from("fake-mp4-bytes");
const noSleep = async () => {};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

let tmp: string;
let calls: Call[];

function stubFetch(handler: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function completed(content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "v1_abc",
    status: "completed",
    model: GEMINI_OMNI_MODEL_DEFAULT,
    object: "interaction",
    steps: [
      { type: "thought", content: [{ type: "thought", text: "..." }] },
      { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", ...content }] },
    ],
    ...extra,
  };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-omni-"));
  calls = [];
  _resetGeminiKeyCooldowns();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "VIDEO_GEN_MODEL") {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY") || k === "VIDEO_GEN_MODEL") {
      Reflect.deleteProperty(process.env, k);
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
});

describe("video model routing", () => {
  it("defaults to GA Omni and keeps the VIDEO_GEN_MODEL override", () => {
    expect(getDefaultModel("generate-video")).toBe("gemini-omni-1.1-flash");
    process.env.VIDEO_GEN_MODEL = "veo-3.1-generate-preview";
    expect(getDefaultModel("generate-video")).toBe("veo-3.1-generate-preview");
  });

  it("routes by model family and rejects anything else instead of rerouting", () => {
    expect(videoModelFamily("gemini-omni-1.1-flash")).toBe("omni");
    expect(videoModelFamily("models/gemini-omni-1.1-flash")).toBe("omni");
    expect(videoModelFamily("veo-3.1-generate-preview")).toBe("veo");
    expect(() => videoModelFamily("gemini-3.6-flash")).toThrow(ValidationError);
  });

  it("warns about announced shutdowns only", () => {
    const before = new Date("2026-10-20T00:00:00Z");
    const after = new Date("2026-10-23T00:00:00Z");
    expect(videoModelDeprecation("veo-3.1-generate-preview", before)).toContain(
      "shuts down on 2026-10-22",
    );
    expect(videoModelDeprecation("models/veo-3.1-generate-preview", after)).toContain(
      "was shut down on 2026-10-22",
    );
    expect(videoModelDeprecation("gemini-omni-1.1-flash", after)).toBeUndefined();
  });
});

describe("buildOmniRequest", () => {
  it("sends a plain prompt as a string input with a video response format", () => {
    expect(buildOmniRequest({ model: "models/gemini-omni-1.1-flash", prompt: " a cat " })).toEqual({
      model: "gemini-omni-1.1-flash",
      input: "a cat",
      response_format: { type: "video" },
    });
  });

  it("orders video, images, then text and maps every option", () => {
    const body = buildOmniRequest({
      model: "gemini-omni-1.1-flash",
      prompt: "extend",
      video: { uri: `${API}/files/v1`, mimeType: "video/mp4" },
      images: [{ data: "AAA", mimeType: "image/png" }, { uri: `${API}/files/i1` }],
      previousInteractionId: "v1_prev",
      aspectRatio: "9:16",
      resolution: "1080p",
      delivery: "uri",
      task: "extend",
      store: false,
    });
    expect(body).toEqual({
      model: "gemini-omni-1.1-flash",
      input: [
        { type: "video", uri: `${API}/files/v1`, mime_type: "video/mp4" },
        { type: "image", data: "AAA", mime_type: "image/png" },
        { type: "image", uri: `${API}/files/i1` },
        { type: "text", text: "extend" },
      ],
      previous_interaction_id: "v1_prev",
      response_format: {
        type: "video",
        aspect_ratio: "9:16",
        resolution: "1080p",
        delivery: "uri",
      },
      generation_config: { video_config: { task: "extend" } },
      store: false,
    });
  });

  it("rejects options Omni does not support", () => {
    const base = { model: "gemini-omni-1.1-flash", prompt: "x" };
    expect(() => buildOmniRequest({ ...base, aspectRatio: "1:1" })).toThrow(ValidationError);
    expect(() => buildOmniRequest({ ...base, resolution: "2k" })).toThrow(ValidationError);
    expect(() => buildOmniRequest({ ...base, task: "upscale" })).toThrow(ValidationError);
    expect(() => buildOmniRequest({ ...base, store: false, background: true })).toThrow(
      ValidationError,
    );
    expect(() => buildOmniRequest({ ...base, prompt: "  " })).toThrow(ValidationError);
  });
});

describe("extractOmniVideo", () => {
  it("reads inline data and URI videos from the REST steps", () => {
    expect(extractOmniVideo(completed({ data: "QUJD" }))).toEqual({
      mimeType: "video/mp4",
      data: "QUJD",
    });
    expect(extractOmniVideo(completed({ uri: `${API}/files/x:download?alt=media` }))).toEqual({
      mimeType: "video/mp4",
      uri: `${API}/files/x:download?alt=media`,
    });
  });

  it("ignores the SDK-only output_video field and the caller's own input video", () => {
    const resp = {
      output_video: { uri: "https://evil.example/v.mp4" },
      steps: [{ type: "user_input", content: [{ type: "video", data: "SU5QVVQ=" }] }],
    };
    expect(extractOmniVideo(resp)).toBeUndefined();
    expect(extractOmniVideo({})).toBeUndefined();
    expect(extractOmniVideo(null)).toBeUndefined();
  });
});

describe("geminiFileName", () => {
  it("accepts only https Files API URIs on the Gemini host", () => {
    expect(geminiFileName(`${API}/files/abc-1:download?alt=media`)).toBe("files/abc-1");
    expect(geminiFileName(`${API}/files/abc`)).toBe("files/abc");
    expect(geminiFileName("http://generativelanguage.googleapis.com/v1beta/files/a")).toBe(
      undefined,
    );
    expect(geminiFileName("https://generativelanguage.googleapis.com:8443/v1beta/files/a")).toBe(
      undefined,
    );
    expect(geminiFileName("https://evil.example/v1beta/files/a")).toBeUndefined();
    expect(geminiFileName(`${API}/files/../models`)).toBeUndefined();
    expect(geminiFileName("not a url")).toBeUndefined();
  });
});

describe("runOmni", () => {
  const settings = () => omniSettings({ resolution: "720p" });

  it("downloads a URI video with the key on the API host only and writes a session record", async () => {
    let fileGets = 0;
    stubFetch((call) => {
      if (call.method === "POST" && call.url === `${API}/interactions`) {
        return json(completed({ uri: `${API}/files/vid1:download?alt=media` }));
      }
      if (call.url === `${API}/files/vid1`) {
        fileGets += 1;
        return json({ name: "files/vid1", state: fileGets < 2 ? "PROCESSING" : "ACTIVE" });
      }
      if (call.url === `${API}/files/vid1:download?alt=media`) return new Response(MP4);
      throw new Error(`unexpected ${call.url}`);
    });
    const dest = path.join(tmp, "clip.mp4");
    const result = await runOmni({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      prompt: "a boat",
      settings: settings(),
      dest,
      logger,
      command: "test",
      sleep: noSleep,
    });

    expect(fs.readFileSync(dest)).toEqual(MP4);
    expect(calls[0]?.body).toEqual({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      input: "a boat",
      response_format: { type: "video", resolution: "720p", delivery: "uri" },
    });
    for (const call of calls) expect(call.headers["x-goog-api-key"]).toBe(KEY);
    expect(fileGets).toBe(2);

    const raw = fs.readFileSync(result.sessionPath, "utf8");
    expect(raw).not.toContain(KEY);
    const record = JSON.parse(raw) as OmniSessionRecord;
    expect(record).toMatchObject({
      kind: "gemini-omni-video",
      interaction_id: "v1_abc",
      key_env: "GEMINI_API_KEY",
      status: "completed",
      store: true,
      media_file: "files/vid1",
      output_path: path.resolve(dest),
    });
    expect(result.sessionPath).toBe(sessionPathFor(dest));
  });

  it("decodes inline video data", async () => {
    stubFetch(() => json(completed({ data: MP4.toString("base64") })));
    const dest = path.join(tmp, "inline.mp4");
    await runOmni({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      prompt: "x",
      settings: omniSettings({ delivery: "inline" }),
      dest,
      logger,
      command: "test",
    });
    expect(fs.readFileSync(dest)).toEqual(MP4);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.response_format).toEqual({ type: "video" });
  });

  it("fetches a non-Gemini https URI without credentials", async () => {
    stubFetch((call) => {
      if (call.method === "POST") return json(completed({ uri: "https://cdn.example/v.mp4" }));
      return new Response(MP4);
    });
    await runOmni({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      prompt: "x",
      settings: settings(),
      dest: path.join(tmp, "cdn.mp4"),
      logger,
      command: "test",
    });
    expect(calls[1]?.url).toBe("https://cdn.example/v.mp4");
    expect(calls[1]?.headers["x-goog-api-key"]).toBeUndefined();
  });

  it("never resends a create request whose outcome is unknown", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      runOmni({
        model: GEMINI_OMNI_MODEL_DEFAULT,
        prompt: "x",
        settings: settings(),
        dest: path.join(tmp, "lost.mp4"),
        logger,
        command: "test",
      }),
    ).rejects.toThrow(/may still finish and be billed/);
    expect(calls).toHaveLength(1);
  });

  it("rotates keys only on a rate-limited (not accepted) create, then stays on that key", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    stubFetch((call) => {
      if (call.method === "POST" && call.headers["x-goog-api-key"] === KEY) {
        return json({ error: { status: "RESOURCE_EXHAUSTED" } }, 429);
      }
      if (call.method === "POST") return json({ id: "v1_bg", status: "in_progress" });
      return json(completed({ data: MP4.toString("base64") }, { id: "v1_bg" }));
    });
    const dest = path.join(tmp, "bg.mp4");
    const result = await runOmni({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      prompt: "x",
      settings: omniSettings({ background: true }),
      dest,
      logger,
      command: "test",
      sleep: noSleep,
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
    expect(calls[1]?.body?.background).toBe(true);
    expect(calls[2]?.url).toBe(`${API}/interactions/v1_bg`);
    expect(calls[2]?.headers["x-goog-api-key"]).toBe(KEY2);
    expect(fs.readFileSync(dest)).toEqual(MP4);
    const record = JSON.parse(fs.readFileSync(result.sessionPath, "utf8")) as OmniSessionRecord;
    expect(record.key_env).toBe("GEMINI_API_KEY_2");
  });

  it("reports a failed interaction and keeps its record", async () => {
    stubFetch(() =>
      json({ id: "v1_bad", status: "failed", error: { message: "blocked by safety" } }),
    );
    const dest = path.join(tmp, "bad.mp4");
    await expect(
      runOmni({
        model: GEMINI_OMNI_MODEL_DEFAULT,
        prompt: "x",
        settings: settings(),
        dest,
        logger,
        command: "test",
      }),
    ).rejects.toThrow(ProviderError);
    const record = JSON.parse(fs.readFileSync(sessionPathFor(dest), "utf8")) as OmniSessionRecord;
    expect(record.status).toBe("failed");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("uploads a local video on the same key and sends it as a video part", async () => {
    const video = path.join(tmp, "in.mp4");
    fs.writeFileSync(video, MP4);
    stubFetch((call) => {
      if (call.url.includes("/upload/v1beta/files")) {
        return new Response(null, {
          headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/up/1" },
        });
      }
      if (call.url.endsWith("/up/1")) {
        return new Response(
          JSON.stringify({
            file: {
              name: "files/up1",
              uri: `${API}/files/up1`,
              state: "ACTIVE",
              mimeType: "video/mp4",
            },
          }),
          { headers: { "x-goog-upload-status": "final" } },
        );
      }
      return json(completed({ data: MP4.toString("base64") }));
    });
    await runOmni({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      prompt: "make it night",
      settings: settings(),
      videoPath: video,
      dest: path.join(tmp, "edit.mp4"),
      logger,
      command: "test",
    });
    const create = calls.find((c) => c.url === `${API}/interactions`);
    expect(create?.body?.input).toEqual([
      { type: "video", uri: `${API}/files/up1`, mime_type: "video/mp4" },
      { type: "text", text: "make it night" },
    ]);
    expect(create?.headers["x-goog-api-key"]).toBe(KEY);
  });
});

describe("follow-up sources and key pinning", () => {
  function record(extra: Partial<OmniSessionRecord> = {}): string {
    const file = path.join(tmp, "s.interaction.json");
    writeSessionRecord(file, {
      kind: "gemini-omni-video",
      interaction_id: "v1_prev",
      model: GEMINI_OMNI_MODEL_DEFAULT,
      key_env: "GEMINI_API_KEY_2",
      store: true,
      status: "completed",
      created_at: "",
      updated_at: "",
      request: {},
      ...extra,
    });
    return file;
  }

  it("needs exactly one source", () => {
    expect(() => resolveFollowUpSource({})).toThrow(ValidationError);
    expect(() => resolveFollowUpSource({ interactionId: "v1_a", video: "a.mp4" })).toThrow(
      ValidationError,
    );
    expect(() => resolveFollowUpSource({ interactionId: "../models" })).toThrow(ValidationError);
  });

  it("continues a session on the key that created it", () => {
    expect(resolveFollowUpSource({ session: record() })).toEqual({
      previousInteractionId: "v1_prev",
      keyEnv: "GEMINI_API_KEY_2",
    });
    expect(() => resolveFollowUpSource({ session: record({ store: false }) })).toThrow(
      /--no-store/,
    );
  });

  it("pins a named key without rotation", async () => {
    process.env.GEMINI_API_KEY_2 = KEY2;
    await expect(withNamedGeminiKey("GEMINI_API_KEY_2", async (k) => k)).resolves.toBe(KEY2);
    await expect(withNamedGeminiKey("GEMINI_API_KEY_9", async (k) => k)).rejects.toThrow(
      ConfigError,
    );
    await expect(withNamedGeminiKey("PATH", async (k) => k)).rejects.toThrow(ConfigError);
  });
});
