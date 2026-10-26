/**
 * OpenRouter transcription client with an injected fetch: multipart upload
 * versus URL JSON body, the parsed transcript and usage, error mapping
 * (4xx/429/5xx, empty or malformed transcript, oversized input or response),
 * the never-retried POST and its unknown-state errors, and the catalog. No
 * network.
 */

import { describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { HttpError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { UNKNOWN_REMOTE_STATE } from "../../../../src/providers/openrouter/speech-client.js";
import {
  MAX_UPLOAD_BYTES,
  type TranscriptionAudio,
  checkAudioUrl,
  createTranscription,
  findTranscriptionModel,
  listTranscriptionModels,
  parseTranscriptionModels,
} from "../../../../src/providers/openrouter/transcription-client.js";

const KEY = "sk-or-v1-SECRET_KEY_VALUE";
const BASE = "https://openrouter.test/api/v1";
const MODEL = "openai/whisper-large-v3-turbo";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 1, 2]);
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const bytes: TranscriptionAudio = { kind: "bytes", data: AUDIO, format: "mp3" };

function jsonResponse(status: number, value: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-generation-id": "gen-stt-1", ...extra },
  });
}

const OK = { text: "Hello there.", usage: { seconds: 2.5, cost: 0.000008 } };

function transcribe(
  fetch: typeof globalThis.fetch,
  audio: TranscriptionAudio = bytes,
  language?: string,
) {
  return createTranscription({
    model: MODEL,
    audio,
    ...(language ? { language } : {}),
    headers,
    baseUrl: BASE,
    fetch,
  });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a failure");
}

describe("createTranscription", () => {
  it("uploads a file as multipart once and parses the transcript and usage", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, OK));
    const out = await transcribe(fetch as unknown as typeof globalThis.fetch, bytes, "en");
    expect(out).toEqual({
      text: "Hello there.",
      durationS: 2.5,
      usage: { seconds: 2.5, cost: 0.000008 },
      generationId: "gen-stt-1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/audio/transcriptions`);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(MODEL);
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
    // fetch must set the multipart boundary itself.
    const sent = new Headers(init.headers);
    expect(sent.get("content-type")).toBeNull();
    expect(sent.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("sends a URL as JSON input_audio for the provider to download", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { ...OK, language: "english" }));
    const out = await transcribe(fetch as unknown as typeof globalThis.fetch, {
      kind: "url",
      url: "https://cdn.example.com/a/meeting.mp3?sig=abc",
      format: "mp3",
    });
    expect(out.language).toBe("english");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      model: MODEL,
      input_audio: { url: "https://cdn.example.com/a/meeting.mp3?sig=abc", format: "mp3" },
    });
  });

  it.each([
    [400, "Unsupported audio format"],
    [401, "Missing Authentication header"],
    [402, "Insufficient credits"],
    [413, "Payload Too Large"],
    [429, "Rate limit exceeded"],
    [502, "Provider returned error"],
    [503, "Provider overloaded"],
  ])("maps HTTP %i to an HttpError carrying OpenRouter's message", async (status, msg) => {
    const fetch = vi.fn(async () =>
      jsonResponse(status, { error: { message: msg, code: status } }, { "retry-after": "3" }),
    );
    const err = await failure(transcribe(fetch as unknown as typeof globalThis.fetch));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as HttpError).snippet).toBe(msg);
    expect((err as HttpError).retryAfterMs).toBe(3000);
    expect(err.message).not.toContain(KEY);
    // A paid POST is never retried, whatever the status.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(classifyError(err).retryable).toBe(status === 429 || status >= 500);
  });

  it("reports an unknown remote state for a gateway 5xx page without OpenRouter's JSON error", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html", "x-generation-id": "gen-stt-5" },
        }),
    );
    const err = await failure(transcribe(fetch as unknown as typeof globalThis.fetch));
    expect((err as { code?: string }).code).toBe(UNKNOWN_REMOTE_STATE);
    expect(err.message).toContain("gen-stt-5");
    expect(classifyError(err).retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails on an empty transcript and names the generation", async () => {
    const err = await failure(transcribe(async () => jsonResponse(200, { text: "  ", usage: {} })));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("empty transcript");
    expect(err.message).toContain("gen-stt-1");
  });

  it("fails on a malformed or text-less answer", async () => {
    const malformed = async () =>
      new Response("{not json", { headers: { "content-type": "application/json" } });
    expect((await failure(transcribe(malformed))).message).toContain("malformed");
    const noText = async () => jsonResponse(200, { usage: { cost: 0.1 } });
    expect((await failure(transcribe(noText))).message).toContain("no transcript text");
    const errorBody = async () => jsonResponse(200, { error: { message: "Audio too long" } });
    expect((await failure(transcribe(errorBody))).message).toContain("Audio too long");
  });

  it("refuses audio over the 25 MB upload cap before any request", async () => {
    const fetch = vi.fn();
    const big: TranscriptionAudio = {
      kind: "bytes",
      data: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      format: "wav",
    };
    const err = await failure(transcribe(fetch as unknown as typeof globalThis.fetch, big));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unknown remote state when the connection drops after sending", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    const err = await failure(transcribe(fetch));
    expect((err as { code?: string }).code).toBe(UNKNOWN_REMOTE_STATE);
    expect(err.message).toContain("transcription request");
    expect(err.message).toContain("may be billed");
    expect(classifyError(err).retryable).toBe(false);
  });

  it("names the generation when the response body breaks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"Hel'));
        controller.error(new Error("socket hang up"));
      },
    });
    const fetch = async () =>
      new Response(stream, {
        headers: { "content-type": "application/json", "x-generation-id": "gen-stt-9" },
      });
    const err = await failure(transcribe(fetch));
    expect((err as { code?: string }).code).toBe(UNKNOWN_REMOTE_STATE);
    expect(err.message).toContain("multix openrouter generation gen-stt-9");
  });

  it("treats a refused connection as never sent (a plain network error)", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const err = await failure(transcribe(fetch));
    expect((err as { code?: string }).code).not.toBe(UNKNOWN_REMOTE_STATE);
    expect((err as HttpError).status).toBe(0);
  });
});

describe("checkAudioUrl", () => {
  it("accepts http(s) and refuses other schemes, credentials and overlong URLs", () => {
    expect(checkAudioUrl("https://example.com/a.mp3").hostname).toBe("example.com");
    expect(() => checkAudioUrl("file:///etc/passwd")).toThrow(ValidationError);
    expect(() => checkAudioUrl("https://user:pw@example.com/a.mp3")).toThrow(/credentials/);
    expect(() => checkAudioUrl(`https://example.com/${"a".repeat(8000)}.mp3`)).toThrow(/8000/);
    expect(() => checkAudioUrl("not a url")).toThrow(ValidationError);
  });
});

describe("transcription catalog", () => {
  const catalog = {
    data: [
      {
        id: "openai/whisper-1",
        canonical_slug: "openai/whisper-1",
        name: "OpenAI: Whisper",
        pricing: { prompt: "0.0001", completion: "0" },
        architecture: { output_modalities: ["transcription"] },
      },
      {
        id: "google/gemini-3.5-transcribe",
        canonical_slug: "google/gemini-3.5-transcribe-20260827",
        pricing: { prompt: "0.000002", completion: "0.000012" },
      },
      { id: "fish-audio/drama-3", architecture: { output_modalities: ["speech"] } },
      { name: "no id" },
    ],
  };

  it("keeps transcription models with their prices", () => {
    const models = parseTranscriptionModels(catalog);
    expect(models.map((m) => m.id)).toEqual(["openai/whisper-1", "google/gemini-3.5-transcribe"]);
    expect(models[0]?.pricing).toEqual({ prompt: "0.0001", completion: "0" });
    expect(() => parseTranscriptionModels({})).toThrow(ProviderError);
  });

  it("lists models from the public endpoint without a key and finds by id or slug", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, catalog));
    const models = await listTranscriptionModels({
      baseUrl: BASE,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/models?output_modalities=transcription`);
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(findTranscriptionModel(models, "GOOGLE/gemini-3.5-transcribe-20260827")?.id).toBe(
      "google/gemini-3.5-transcribe",
    );
    expect(findTranscriptionModel(models, "openai/whisper-2")).toBeUndefined();
  });
});
