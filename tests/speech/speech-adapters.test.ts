/**
 * Speech provider adapters with globalThis.fetch mocked: the request each one
 * sends (body, headers, URL), the bytes it saves, and the single-request rule
 * on a provider error. Routes come from planSpeechRoutes, as in the CLI.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEECH_ADAPTERS } from "../../src/commands/speech/speech-adapters.js";
import { ConfigError, HttpError, ProviderError } from "../../src/core/errors.js";
import { createLogger } from "../../src/core/logger.js";
import { _resetOutputDir } from "../../src/core/output-dir.js";
import type { SpeechProvider } from "../../src/speech/speech-catalog.js";
import {
  type SpeechInput,
  type SpeechRoute,
  planSpeechRoutes,
} from "../../src/speech/speech-request.js";
import {
  type FetchHandler,
  type RecordedCall,
  audioReply,
  jsonReply,
  recordFetch,
  setSpeechEnv,
} from "./speech-test-helpers.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let tmp: string;
let restoreEnv: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
let calls: RecordedCall[];

/** Replace the fetch mock; the default fails any request, so an unexpected call is visible. */
function useFetch(handler: FetchHandler): void {
  restoreFetch?.();
  const mock = recordFetch(handler);
  calls = mock.calls;
  restoreFetch = mock.restore;
}

/** Set the env for one test: the output dir plus the given keys and settings. */
function useEnv(vars: Record<string, string | undefined> = {}): void {
  restoreEnv?.();
  restoreEnv = setSpeechEnv({ MULTIX_OUTPUT_DIR: tmp, ...vars });
  _resetOutputDir();
}

function input(over: Partial<SpeechInput> = {}): SpeechInput {
  return { text: "Hello there.", speakers: [], async: false, extras: {}, ...over };
}

/** The route the CLI would plan for these options, with the adapter's own default model. */
function plan(
  provider: SpeechProvider,
  model: string | undefined,
  over: Partial<SpeechInput> = {},
): SpeechRoute {
  return planSpeechRoutes({
    provider,
    model,
    fallbacks: [],
    input: input(over),
    defaultModel: (p) => SPEECH_ADAPTERS[p].defaultModel(),
  }).routes[0] as SpeechRoute;
}

function ctx(output?: string) {
  return { output, logger: createLogger({ verbose: false, stderr: true }), verbose: false };
}

const posts = () => calls.filter((c) => c.method === "POST");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-speech-adapters-"));
  useEnv();
  useFetch(() => {
    throw new Error("unexpected network call");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreFetch?.();
  restoreEnv?.();
  restoreFetch = undefined;
  restoreEnv = undefined;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("requireKey sends nothing", () => {
  it.each<SpeechProvider>(["gemini", "openai", "elevenlabs", "minimax", "atlas", "fish"])(
    "%s throws ConfigError without a key and makes no request",
    (provider) => {
      useEnv();
      expect(() => SPEECH_ADAPTERS[provider].requireKey()).toThrow(ConfigError);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("openai adapter", () => {
  it("posts the routed model, voice and format and saves the exact bytes", async () => {
    useEnv({ OPENAI_API_KEY: "sk-test-openai" });
    const bytes = Buffer.from("fake mp3 bytes for openai tts-1");
    useFetch(() => audioReply(bytes));

    const route = plan("openai", "tts-1", { voice: "alloy" });
    const out = await SPEECH_ADAPTERS.openai.generate(route, input(), ctx());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.openai.com/v1/audio/speech",
      body: { model: "tts-1", input: "Hello there.", voice: "alloy", response_format: "mp3" },
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test-openai");
    expect(out.files).toHaveLength(1);
    const saved = fs.readFileSync(out.files[0] as string);
    expect(path.basename(out.files[0] as string)).toMatch(/^openai-speech-.+\.mp3$/);
    expect(sha256(saved)).toBe(sha256(bytes));
  });

  it("sends instructions only when a style is given", async () => {
    useEnv({ OPENAI_API_KEY: "sk-test-openai" });
    useFetch(() => audioReply(Buffer.from("x")));

    await SPEECH_ADAPTERS.openai.generate(
      plan("openai", undefined, { style: "warm, unhurried" }),
      input({ style: "warm, unhurried" }),
      ctx(),
    );
    await SPEECH_ADAPTERS.openai.generate(plan("openai", undefined), input(), ctx());

    expect((calls[0]?.body as Record<string, unknown>).instructions).toBe("warm, unhurried");
    expect(calls[1]?.body).not.toHaveProperty("instructions");
    expect((calls[1]?.body as Record<string, unknown>).voice).toBe("marin");
  });

  it("copies the audio to --output, creating its directory", async () => {
    useEnv({ OPENAI_API_KEY: "sk-test-openai" });
    const bytes = Buffer.from("copy me");
    useFetch(() => audioReply(bytes));
    const target = path.join(tmp, "nested", "dir", "clip.mp3");

    await SPEECH_ADAPTERS.openai.generate(plan("openai", undefined), input(), ctx(target));

    expect(fs.readFileSync(target)).toEqual(bytes);
  });

  it("a 500 is one POST and surfaces as HttpError", async () => {
    useEnv({ OPENAI_API_KEY: "sk-test-openai" });
    useFetch(() => jsonReply({ error: { message: "upstream exploded" } }, 500));

    await expect(
      SPEECH_ADAPTERS.openai.generate(plan("openai", undefined), input(), ctx()),
    ).rejects.toBeInstanceOf(HttpError);
    expect(posts()).toHaveLength(1);
  });
});

describe("fish adapter", () => {
  /** Two MPEG-1 Layer III frames: enough for the audio check to accept the bytes as mp3. */
  const MP3 = Buffer.alloc(834);
  MP3.set([0xff, 0xfb, 0x90, 0x64], 0);
  MP3.set([0xff, 0xfb, 0x90, 0x64], 417);

  it("posts to /v1/tts with the drama-3 header, a public voice id and the mapped extras", async () => {
    useEnv({ FISH_API_KEY: "fish-test-key" });
    useFetch(() => audioReply(MP3));
    const over = {
      voice: "sheila",
      language: "vi",
      extras: { "fish.speed": "1.25", "fish.normalize": "false", "fish.latency": "balanced" },
    };

    const out = await SPEECH_ADAPTERS.fish.generate(
      plan("fish", undefined, over),
      input(over),
      ctx(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.fish.audio/v1/tts",
      body: {
        text: "Hello there.",
        format: "mp3",
        reference_id: "f3a2b90078d54a65af4b95f63bc7798e",
        prosody: { speed: 1.25 },
        normalize: false,
        language: "vi",
        latency: "balanced",
      },
    });
    expect(calls[0]?.headers.model).toBe("drama-3");
    expect(calls[0]?.headers.authorization).toBe("Bearer fish-test-key");
    expect(path.basename(out.files[0] as string)).toMatch(/^fish_tts_.+\.mp3$/);
    expect(sha256(fs.readFileSync(out.files[0] as string))).toBe(sha256(MP3));
  });

  it("uses FISH_TTS_MODEL as the default model header", async () => {
    useEnv({ FISH_API_KEY: "fish-test-key", FISH_TTS_MODEL: "s2.1-pro" });
    useFetch(() => audioReply(MP3));
    await SPEECH_ADAPTERS.fish.generate(plan("fish", undefined), input(), ctx());
    expect(calls[0]?.headers.model).toBe("s2.1-pro");
  });

  it("a 500 JSON error is one POST and surfaces as HttpError", async () => {
    useEnv({ FISH_API_KEY: "fish-test-key" });
    useFetch(() => jsonReply({ status: 500, message: "boom" }, 500));
    await expect(
      SPEECH_ADAPTERS.fish.generate(plan("fish", undefined), input(), ctx()),
    ).rejects.toBeInstanceOf(HttpError);
    expect(posts()).toHaveLength(1);
  });
});

describe("elevenlabs adapter", () => {
  const VOICE_ALEXANDRA = "kdmDKE6EkgrWrrykO9Qt";

  it("v3 with a language sends language_code and only the voice settings it was given", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));
    const over = {
      language: "en",
      extras: { "elevenlabs.stability": "0.4", "elevenlabs.similarity_boost": "0.8" },
    };

    await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", "eleven_v3", over),
      input(over),
      ctx(),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ALEXANDRA}?output_format=mp3_44100_128`,
    );
    expect(call.headers["xi-api-key"]).toBe("el-test-key");
    expect(call.body).toEqual({
      text: "Hello there.",
      model_id: "eleven_v3",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      language_code: "en",
    });
  });

  it("v2 multilingual never sends language_code, even for a documented language", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));
    const over = { language: "en" };

    await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", "eleven_multilingual_v2", over),
      input(over),
      ctx(),
    );

    expect(calls[0]?.body).toEqual({
      text: "Hello there.",
      model_id: "eleven_multilingual_v2",
    });
  });

  it("flash v2.5 sends language_code for Vietnamese", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));
    const over = { language: "vi" };

    await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", "eleven_flash_v2_5", over),
      input(over),
      ctx(),
    );

    expect((calls[0]?.body as Record<string, unknown>).language_code).toBe("vi");
  });

  it("omits voice_settings when no setting extra is given", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));

    await SPEECH_ADAPTERS.elevenlabs.generate(plan("elevenlabs", undefined), input(), ctx());

    expect(calls[0]?.body).not.toHaveProperty("voice_settings");
    expect(calls[0]?.body).not.toHaveProperty("language_code");
  });

  it("builds voice_settings from the setting extras alone", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));
    const over = { extras: { "elevenlabs.use_speaker_boost": "true" } };

    await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", undefined, over),
      input(over),
      ctx(),
    );

    expect((calls[0]?.body as Record<string, unknown>).voice_settings).toEqual({
      use_speaker_boost: true,
    });
  });

  it("sends seed and the surrounding text at the top level", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => audioReply(Buffer.from("el mp3")));
    const over = {
      extras: {
        "elevenlabs.seed": "7",
        "elevenlabs.previous_text": "Earlier.",
        "elevenlabs.next_text": "Later.",
      },
    };

    await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", undefined, over),
      input(over),
      ctx(),
    );

    expect(calls[0]?.body).toMatchObject({
      seed: 7,
      previous_text: "Earlier.",
      next_text: "Later.",
    });
    expect(calls[0]?.body).not.toHaveProperty("voice_settings");
  });

  it("pcm asks for pcm_24000 and saves a .pcm file", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    const bytes = Buffer.from([0, 0, 1, 0, 2, 0]);
    useFetch(() => audioReply(bytes));

    const out = await SPEECH_ADAPTERS.elevenlabs.generate(
      plan("elevenlabs", undefined, { format: "pcm" }),
      input({ format: "pcm" }),
      ctx(),
    );

    expect(new URL(calls[0]?.url ?? "").searchParams.get("output_format")).toBe("pcm_24000");
    expect(path.extname(out.files[0] as string)).toBe(".pcm");
    expect(sha256(fs.readFileSync(out.files[0] as string))).toBe(sha256(bytes));
  });

  it("a 500 is one POST and surfaces as HttpError", async () => {
    useEnv({ ELEVENLABS_API_KEY: "el-test-key" });
    useFetch(() => jsonReply({ detail: "server error" }, 500));

    await expect(
      SPEECH_ADAPTERS.elevenlabs.generate(plan("elevenlabs", undefined), input(), ctx()),
    ).rejects.toBeInstanceOf(HttpError);
    expect(posts()).toHaveLength(1);
  });
});

describe("minimax adapter", () => {
  const speechReply = (bytes: Buffer) =>
    jsonReply({ data: { audio: bytes.toString("hex") }, base_resp: { status_code: 0 } });

  it("pcm is saved as .pcm and no emotion is sent when none is given", async () => {
    useEnv({ MINIMAX_API_KEY: "mm-test-key" });
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
    useFetch(() => speechReply(bytes));

    const out = await SPEECH_ADAPTERS.minimax.generate(
      plan("minimax", "speech-2.8-hd", { format: "pcm" }),
      input({ format: "pcm" }),
      ctx(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.minimax.io/v1/t2a_v2" });
    const body = calls[0]?.body as {
      model: string;
      language_boost: string;
      voice_setting: Record<string, unknown>;
      audio_setting: Record<string, unknown>;
    };
    expect(body.model).toBe("speech-2.8-hd");
    expect(body.audio_setting.format).toBe("pcm");
    expect(body.voice_setting).not.toHaveProperty("emotion");
    expect(body.language_boost).toBe("auto");
    expect(path.extname(out.files[0] as string)).toBe(".pcm");
    expect(sha256(fs.readFileSync(out.files[0] as string))).toBe(sha256(bytes));
  });

  it("maps --language vi to language_boost Vietnamese and sends a given emotion", async () => {
    useEnv({ MINIMAX_API_KEY: "mm-test-key" });
    useFetch(() => speechReply(Buffer.from("mp3")));
    const over = { language: "vi", emotion: "happy" };

    await SPEECH_ADAPTERS.minimax.generate(
      plan("minimax", "speech-2.8-hd", over),
      input(over),
      ctx(),
    );

    const body = calls[0]?.body as {
      language_boost: string;
      voice_setting: Record<string, unknown>;
    };
    expect(body.language_boost).toBe("Vietnamese");
    expect(body.voice_setting.emotion).toBe("happy");
    expect(body.voice_setting.speed).toBe(1);
  });

  it("sends the speed extra as the voice speed", async () => {
    useEnv({ MINIMAX_API_KEY: "mm-test-key" });
    useFetch(() => speechReply(Buffer.from("mp3")));
    const over = { extras: { "minimax.speed": "1.2" } };

    await SPEECH_ADAPTERS.minimax.generate(plan("minimax", undefined, over), input(over), ctx());

    expect((calls[0]?.body as { voice_setting: { speed: number } }).voice_setting.speed).toBe(1.2);
  });

  it("an API error is one request and a ProviderError with the MiniMax code", async () => {
    useEnv({ MINIMAX_API_KEY: "mm-test-key" });
    useFetch(() => jsonReply({ base_resp: { status_code: 1004, status_msg: "auth failed" } }));

    await expect(
      SPEECH_ADAPTERS.minimax.generate(plan("minimax", undefined), input(), ctx()),
    ).rejects.toThrow(ProviderError);
    await expect(
      SPEECH_ADAPTERS.minimax.generate(plan("minimax", undefined), input(), ctx()),
    ).rejects.toThrow(/MiniMax API error \(code 1004\): auth failed/);
    expect(posts()).toHaveLength(2);
  });

  it("a 500 is one POST and surfaces as a failed speech request", async () => {
    useEnv({ MINIMAX_API_KEY: "mm-test-key" });
    useFetch(() => jsonReply({ error: "boom" }, 500));

    await expect(
      SPEECH_ADAPTERS.minimax.generate(plan("minimax", undefined), input(), ctx()),
    ).rejects.toThrow(ProviderError);
    expect(posts()).toHaveLength(1);
  });
});

describe("atlas adapter", () => {
  const SUBMIT = "https://api.atlascloud.ai/api/v1/model/generateAudio";
  /** Catalog and schema lookups fail; the speech path tolerates that and submits without validation. */
  const submitHandler: FetchHandler = (call) =>
    call.method === "POST" && call.url === SUBMIT
      ? jsonReply({ code: 200, data: { id: "pred_123", status: "starting" } })
      : jsonReply({ message: "not found" }, 404);

  it("--async returns the prediction id and a resume command without downloading", async () => {
    useEnv({ ATLASCLOUD_API_KEY: "atlas-test-key" });
    useFetch(submitHandler);
    const over = { async: true, text: "Hello there." };

    const out = await SPEECH_ADAPTERS.atlas.generate(
      plan("atlas", undefined, { async: true }),
      input(over),
      ctx(),
    );

    expect(out).toEqual({
      files: [],
      job: { id: "pred_123", resume: "multix atlas status pred_123 --wait --download" },
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.url).toBe(SUBMIT);
    expect(posts()[0]?.body).toMatchObject({ model: "xai/tts-v1", text: "Hello there." });
    expect(calls.some((c) => c.method === "GET" && c.url.includes("generateAudio"))).toBe(false);
  });

  it("the resume command keeps the --output file it will download to", async () => {
    useEnv({ ATLASCLOUD_API_KEY: "atlas-test-key" });
    useFetch(submitHandler);

    const out = await SPEECH_ADAPTERS.atlas.generate(
      plan("atlas", undefined, { async: true }),
      input({ async: true }),
      ctx("speech.mp3"),
    );

    expect(out.job?.resume).toBe(
      "multix atlas status pred_123 --wait --download --output speech.mp3",
    );
  });

  it("a submit failure is one POST and surfaces as an error", async () => {
    useEnv({ ATLASCLOUD_API_KEY: "atlas-test-key" });
    useFetch((call) =>
      call.method === "POST" ? jsonReply({ code: 500, msg: "down" }, 500) : jsonReply({}, 404),
    );

    await expect(
      SPEECH_ADAPTERS.atlas.generate(
        plan("atlas", undefined, { async: true }),
        input({ async: true }),
        ctx(),
      ),
    ).rejects.toThrow();
    expect(posts()).toHaveLength(1);
  });
});
