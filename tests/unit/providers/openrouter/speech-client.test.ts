/**
 * OpenRouter speech client and audio helpers with an injected fetch: audio
 * bytes and headers, error mapping (4xx/429/5xx, JSON instead of audio, empty
 * or oversized audio), the never-retried POST and its unknown-state errors,
 * the speech catalog, voice matching and /generation stats. No network.
 */

import { describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { HttpError, ProviderError, ResponseTooLargeError } from "../../../../src/core/errors.js";
import {
  looksLikeMp3,
  parseAudioContentType,
  parseSpeechFormat,
  pcmDurationSeconds,
  pcmToWav,
  resolveSpeechFormat,
} from "../../../../src/providers/openrouter/speech-audio.js";
import {
  UNKNOWN_REMOTE_STATE,
  createSpeech,
  findSpeechModel,
  getGeneration,
  listSpeechModels,
  matchVoice,
  parseSpeechModels,
} from "../../../../src/providers/openrouter/speech-client.js";

const KEY = "sk-or-v1-SECRET_KEY_VALUE";
const BASE = "https://openrouter.test/api/v1";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 1, 2]);
const PCM = new Uint8Array(4800); // 0.1 s of 24 kHz mono 16-bit

const body = { model: "fish-audio/drama-3", input: "Hello", response_format: "mp3" as const };
const headers = { Authorization: `Bearer ${KEY}` };

function audioResponse(bytes: Uint8Array, type: string, extra: Record<string, string> = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": type, "x-generation-id": "gen-tts-1-abc", ...extra },
  });
}

function jsonResponse(status: number, value: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function speak(fetch: typeof globalThis.fetch, maxBytes = 1024 * 1024) {
  return createSpeech({ body, headers, maxBytes, baseUrl: BASE, fetch });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure");
}

describe("createSpeech", () => {
  it("posts the body once and returns the mp3 bytes with the generation id", async () => {
    const fetch = vi.fn(async () =>
      audioResponse(MP3, "audio/mpeg", { "x-provider-name": "Fish Audio" }),
    );
    const out = await speak(fetch as unknown as typeof globalThis.fetch);
    expect(out.audio).toEqual(MP3);
    expect(out.contentType.mime).toBe("audio/mpeg");
    expect(out.generationId).toBe("gen-tts-1-abc");
    expect(out.providerName).toBe("Fish Audio");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/audio/speech`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("reads the pcm rate and channels from the content type", async () => {
    const fetch = async () => audioResponse(PCM, "audio/pcm;rate=24000;channels=1");
    const out = await speak(fetch);
    expect(out.contentType).toEqual({ mime: "audio/pcm", sampleRate: 24000, channels: 1 });
    expect(out.audio.byteLength).toBe(PCM.byteLength);
  });

  it("drops a malformed generation id", async () => {
    const fetch = async () =>
      audioResponse(MP3, "audio/mpeg", { "x-generation-id": "bad id with spaces" });
    expect((await speak(fetch)).generationId).toBeUndefined();
  });

  it.each([
    [400, "INVALID_INPUT", "An explicit voice is required for this TTS provider."],
    [401, "AUTH_FAILED", "Missing Authentication header"],
    [402, "INSUFFICIENT_CREDITS", "Insufficient credits"],
    [429, "RATE_LIMITED", "Rate limit exceeded"],
    [502, "PROVIDER_UNAVAILABLE", "Provider returned error"],
  ])("maps HTTP %i to an HttpError carrying OpenRouter's message", async (status, _code, msg) => {
    const fetch = vi.fn(async () =>
      jsonResponse(status, { error: { message: msg, code: status } }, { "retry-after": "3" }),
    );
    const err = await failure(speak(fetch as unknown as typeof globalThis.fetch));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as HttpError).snippet).toBe(msg);
    expect((err as HttpError).retryAfterMs).toBe(3000);
    expect(String(err.message)).not.toContain(KEY);
    // A paid POST is never retried, whatever the status.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(classifyError(err).retryable).toBe(status === 429 || status >= 500);
  });

  it("keeps a non-JSON error body as a bounded snippet", async () => {
    const fetch = async () => new Response("x".repeat(5000), { status: 503 });
    const err = (await failure(speak(fetch))) as HttpError;
    expect(err.snippet.length).toBe(500);
  });

  it("fails when a 2xx answer is JSON instead of audio", async () => {
    const fetch = async () => jsonResponse(200, { error: { message: "moderation flagged" } });
    const err = await failure(speak(fetch));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("moderation flagged");
  });

  it("fails on an empty audio body", async () => {
    const fetch = async () => audioResponse(new Uint8Array(0), "audio/mpeg");
    const err = await failure(speak(fetch));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("0 bytes");
    expect(err.message).toContain("gen-tts-1-abc");
  });

  it("stops reading past maxBytes, declared or streamed", async () => {
    const declared = async () =>
      audioResponse(MP3, "audio/mpeg", { "content-length": String(10_000_000) });
    expect(await failure(speak(declared, 100))).toBeInstanceOf(ResponseTooLargeError);
    const streamed = async () => audioResponse(new Uint8Array(500), "audio/mpeg");
    expect(await failure(speak(streamed, 100))).toBeInstanceOf(ResponseTooLargeError);
  });

  it("reports an unknown remote state when the connection drops after sending", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    const err = await failure(speak(fetch));
    expect((err as { code?: string }).code).toBe(UNKNOWN_REMOTE_STATE);
    expect(err.message).toContain("may be billed");
    expect(err.message).toContain("openrouter.ai/activity");
    expect(err.message).not.toContain(KEY);
    const info = classifyError(err);
    expect(info.retryable).toBe(false);
    expect(info.exit_code).toBe(6);
  });

  it("names the generation when the audio stream breaks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(MP3);
        controller.error(new Error("socket hang up"));
      },
    });
    const fetch = async () =>
      new Response(stream, {
        headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-tts-9-xyz" },
      });
    const err = await failure(speak(fetch));
    expect((err as { code?: string }).code).toBe(UNKNOWN_REMOTE_STATE);
    expect(err.message).toContain("multix openrouter generation gen-tts-9-xyz");
  });

  it("treats a refused connection as never sent (a plain network error)", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const err = await failure(speak(fetch));
    expect((err as { code?: string }).code).not.toBe(UNKNOWN_REMOTE_STATE);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
  });
});

describe("speech catalog", () => {
  const catalog = {
    data: [
      {
        id: "google/gemini-3.8-flash-tts",
        canonical_slug: "google/gemini-3.8-flash-tts-20260922",
        name: "Google: Gemini 3.8 Flash TTS",
        supported_voices: ["Kore", "Puck"],
        pricing: { prompt: "0.00001" },
        architecture: { output_modalities: ["speech"] },
      },
      { id: "fish-audio/drama-3", supported_voices: null, pricing: { prompt: "0.000002" } },
      { id: "openai/gpt-x", architecture: { output_modalities: ["text"] } },
      { name: "no id" },
    ],
  };

  it("keeps speech models with their voices and prices", () => {
    const models = parseSpeechModels(catalog);
    expect(models.map((m) => m.id)).toEqual(["google/gemini-3.8-flash-tts", "fish-audio/drama-3"]);
    expect(models[0]?.voices).toEqual(["Kore", "Puck"]);
    expect(models[1]?.voices).toEqual([]);
    expect(() => parseSpeechModels({ nope: true })).toThrow(ProviderError);
  });

  it("lists models from the public endpoint without a key", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, catalog));
    const models = await listSpeechModels({
      baseUrl: BASE,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(models).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/models?output_modalities=speech`);
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("Bearer");
  });

  it("finds a model by id or dated slug and matches voices ignoring case", () => {
    const models = parseSpeechModels(catalog);
    const gemini = findSpeechModel(models, "GOOGLE/gemini-3.8-flash-tts-20260922");
    expect(gemini?.id).toBe("google/gemini-3.8-flash-tts");
    expect(findSpeechModel(models, "nope/nope-tts")).toBeUndefined();
    if (!gemini) throw new Error("unreachable");
    expect(matchVoice(gemini, "kore")).toBe("Kore");
    expect(matchVoice(gemini, "Nobody")).toBeUndefined();
    const fish = findSpeechModel(models, "fish-audio/drama-3");
    if (!fish) throw new Error("unreachable");
    expect(matchVoice(fish, "any-reference-id")).toBe("any-reference-id");
  });
});

describe("getGeneration", () => {
  it("parses the recorded cost and resolved model", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          id: "gen-tts-1-abc",
          model: "fish-audio/drama-3-20261013",
          provider_name: "Fish Audio",
          total_cost: 0.000048,
          upstream_inference_cost: 0,
          is_byok: false,
          tokens_prompt: 6,
          latency: 141,
        },
      }),
    );
    const stats = await getGeneration({
      id: "gen-tts-1-abc",
      headers,
      baseUrl: BASE,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(stats).toEqual({
      id: "gen-tts-1-abc",
      model: "fish-audio/drama-3-20261013",
      providerName: "Fish Audio",
      totalCost: 0.000048,
      upstreamCost: 0,
      isByok: false,
      tokensPrompt: 6,
      latencyMs: 141,
    });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      `${BASE}/generation?id=gen-tts-1-abc`,
    );
  });

  it("answers undefined while OpenRouter has not recorded it (404)", async () => {
    const fetch = async () => jsonResponse(404, { error: { message: "Generation not found" } });
    expect(await getGeneration({ id: "gen-1", headers, baseUrl: BASE, fetch })).toBeUndefined();
  });
});

describe("speech audio helpers", () => {
  it("resolves formats per model family", () => {
    expect(resolveSpeechFormat("auto", "google/gemini-3.8-flash-tts")).toBe("wav");
    expect(resolveSpeechFormat("auto", "elevenlabs/eleven-v4")).toBe("mp3");
    expect(resolveSpeechFormat("pcm", "elevenlabs/eleven-v4")).toBe("pcm");
    expect(() => resolveSpeechFormat("mp3", "google/gemini-3.8-flash-tts")).toThrow(/pcm only/);
    expect(() => resolveSpeechFormat("wav", "minimax/speech-2.8-hd")).toThrow(/mp3 only/);
    expect(() => parseSpeechFormat("ogg")).toThrow(/Invalid --format/);
    expect(parseSpeechFormat(" WAV ")).toBe("wav");
  });

  it("parses audio content types defensively", () => {
    expect(parseAudioContentType("audio/pcm;rate=24000;channels=1")).toEqual({
      mime: "audio/pcm",
      sampleRate: 24000,
      channels: 1,
    });
    expect(parseAudioContentType("Audio/MPEG")).toEqual({ mime: "audio/mpeg" });
    expect(parseAudioContentType("audio/pcm;rate=abc;channels=99")).toEqual({ mime: "audio/pcm" });
    expect(parseAudioContentType(null)).toEqual({});
  });

  it("wraps pcm in a valid WAV header and measures its duration", () => {
    const wav = pcmToWav(PCM, 24000, 1);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(36 + PCM.byteLength);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(PCM.byteLength);
    expect(wav.byteLength).toBe(44 + PCM.byteLength);
    expect(pcmDurationSeconds(PCM.byteLength, 24000, 1)).toBe(0.1);
  });

  it("recognizes mp3 bytes", () => {
    expect(looksLikeMp3(MP3)).toBe(true);
    expect(looksLikeMp3(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true);
    expect(looksLikeMp3(new Uint8Array([0x7b, 0x22, 0x65]))).toBe(false);
  });
});
