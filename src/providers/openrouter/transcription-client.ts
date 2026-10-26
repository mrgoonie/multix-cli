/**
 * OpenRouter speech-to-text client (runtime-neutral: no node:* imports; the
 * caller passes `fetch` and the request headers, which carry the key).
 *
 * - POST /api/v1/audio/transcriptions takes the audio as an OpenAI-style
 *   multipart upload (at most 25 MB) or as JSON `input_audio.url`, a public
 *   URL the provider downloads itself. It answers JSON `{ text, usage }` with
 *   the generation id in `X-Generation-Id`.
 * - GET /api/v1/models?output_modalities=transcription lists the models
 *   (public, no key).
 *
 * The POST is never retried: a second request is a second paid transcription.
 * Docs: https://openrouter.ai/docs/api/api-reference/stt/create-transcription
 */

import { HttpError, MultixError, ProviderError, ValidationError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, parseRetryAfter } from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import {
  NOT_SENT_CODES,
  OPENROUTER_API_BASE,
  errorCodes,
  errorMessageOf,
  isOpenRouterError,
  readCappedText,
  unknownState,
} from "./speech-client.js";

export { DEFAULT_OPENROUTER_STT_MODEL } from "./speech-defaults.js";
/** OpenRouter's cap on a multipart upload (the same as OpenAI's). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** `input_audio.format` as OpenRouter validates it. */
export const AUDIO_FORMAT = /^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,15}$/;

const MAX_URL_CHARS = 8000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const GENERATION_ID = /^[\w.:-]{1,128}$/;

const MIME_BY_FORMAT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
};

/** Local bytes (sent as multipart) or a public URL (sent as JSON for the provider to download). */
export type TranscriptionAudio =
  | { kind: "bytes"; data: Uint8Array; format: string }
  | { kind: "url"; url: string; format?: string };

export interface CreateTranscriptionOptions {
  model: string;
  audio: TranscriptionAudio;
  /** ISO-639-1 code; auto-detected when omitted. */
  language?: string;
  /** Request headers, Authorization included. */
  headers: Record<string, string>;
  /** Whole request, transcript included. Default 300 s. */
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface TranscriptionUsage {
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD OpenRouter reports for this request. */
  cost?: number;
}

export interface Transcription {
  text: string;
  /** Detected or requested language, when the response states it. */
  language?: string;
  /** Audio length in seconds (`usage.seconds`, else `duration`). */
  durationS?: number;
  usage: TranscriptionUsage;
  generationId?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate a URL input: http(s), no credentials, within OpenRouter's length cap. */
export function checkAudioUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("The audio URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("The audio URL must use http or https");
  }
  if (url.username || url.password) {
    throw new ValidationError("The audio URL must not carry credentials");
  }
  if (raw.length > MAX_URL_CHARS) {
    throw new ValidationError(
      `The audio URL is ${raw.length} characters; OpenRouter accepts at most ${MAX_URL_CHARS}`,
    );
  }
  return url;
}

function requestInit(opts: CreateTranscriptionOptions): RequestInit {
  const { audio, model, language } = opts;
  if (audio.kind === "url") {
    const body = {
      model,
      input_audio: { url: audio.url, ...(audio.format ? { format: audio.format } : {}) },
      ...(language ? { language } : {}),
    };
    return {
      method: "POST",
      headers: { ...opts.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  // fetch sets the multipart Content-Type (with its boundary) for FormData.
  const form = new FormData();
  const type = MIME_BY_FORMAT[audio.format.toLowerCase()] ?? "application/octet-stream";
  form.append("file", new Blob([audio.data], { type }), `audio.${audio.format}`);
  form.append("model", model);
  if (language) form.append("language", language);
  const headers = { ...opts.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "content-type") delete headers[name];
  }
  return { method: "POST", headers, body: form };
}

/** Parse the JSON answer; a missing or blank transcript is a ProviderError. */
export function parseTranscription(
  body: unknown,
  model: string,
  generationId?: string,
): Transcription {
  const data = body as Record<string, unknown> | null;
  const gen = generationId ? ` (generation ${generationId})` : "";
  if (!data || typeof data !== "object" || typeof data.text !== "string") {
    const detail =
      data && typeof data === "object" && data.error !== undefined
        ? `: ${errorMessageOf(JSON.stringify(data))}`
        : "";
    throw new ProviderError(
      `OpenRouter returned no transcript text for ${model}${gen}${detail}`,
      "openrouter",
    );
  }
  if (data.text.trim() === "") {
    throw new ProviderError(
      `OpenRouter returned an empty transcript for ${model}${gen}: the audio may be silent or not match its format; the request may still be billed`,
      "openrouter",
    );
  }
  const u = (data.usage ?? {}) as Record<string, unknown>;
  const usage: TranscriptionUsage = {};
  const seconds = num(u.seconds);
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cost = num(u.cost);
  if (seconds !== undefined) usage.seconds = seconds;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cost !== undefined) usage.cost = cost;
  const durationS = seconds ?? num(data.duration);
  const language = str(data.language);
  return {
    text: data.text,
    ...(language ? { language } : {}),
    ...(durationS !== undefined ? { durationS } : {}),
    usage,
    ...(generationId ? { generationId } : {}),
  };
}

/** Read the JSON answer under a size cap; stream errors propagate. */
async function readBody(response: Response, model: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProviderError(
        `OpenRouter's transcription response for ${model} is larger than ${MAX_RESPONSE_BYTES} bytes`,
        "openrouter",
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Transcribe audio. Errors: HttpError for a non-2xx answer (message =
 * OpenRouter's error text), ProviderError for a 2xx answer without a usable
 * transcript, and UNKNOWN_REMOTE_STATE when the connection broke after the
 * request may have reached OpenRouter.
 */
export async function createTranscription(
  opts: CreateTranscriptionOptions,
): Promise<Transcription> {
  const url = `${opts.baseUrl ?? OPENROUTER_API_BASE}/audio/transcriptions`;
  const { model } = opts;
  if (opts.audio.kind === "bytes" && opts.audio.data.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `The audio is ${opts.audio.data.byteLength} bytes; OpenRouter uploads are limited to ${MAX_UPLOAD_BYTES} bytes (25 MB)`,
    );
  }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      url,
      { ...requestInit(opts), signal },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    if (cause instanceof MultixError) throw cause;
    const mapped = toFetchError(cause, url, { provider: "openrouter" });
    const notSent = errorCodes(cause).some((c) => NOT_SENT_CODES.has(c));
    if (mapped instanceof HttpError && !notSent) {
      throw unknownState(
        model,
        mapped.snippet || "connection lost",
        undefined,
        cause,
        "transcription",
      );
    }
    throw mapped;
  }

  const rawId = response.headers.get("x-generation-id")?.trim();
  const generationId = rawId && GENERATION_ID.test(rawId) ? rawId : undefined;

  if (!response.ok) {
    const text = await readCappedText(response, 64 * 1024);
    // A gateway page (502/504/524 HTML from the edge) does not say whether the
    // transcription went on and was billed; OpenRouter's own JSON error does.
    if (response.status >= 500 && !isOpenRouterError(text)) {
      throw unknownState(
        model,
        `HTTP ${response.status} from the gateway`,
        generationId,
        undefined,
        "transcription",
      );
    }
    throw new HttpError(
      response.status,
      errorMessageOf(text),
      url,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  let raw: string;
  try {
    raw = await readBody(response, model);
  } catch (err) {
    if (err instanceof MultixError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw unknownState(model, `response failed: ${reason}`, generationId, err, "transcription");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ProviderError(
      `OpenRouter returned a malformed transcription response for ${model}${generationId ? ` (generation ${generationId})` : ""}`,
      "openrouter",
    );
  }
  return parseTranscription(body, model, generationId);
}

export interface TranscriptionModel {
  id: string;
  canonicalSlug?: string;
  name?: string;
  /** USD per input unit (an audio second, or a token for token-priced models) and per output token. */
  pricing: { prompt?: string; completion?: string };
}

interface RawModel {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { output_modalities?: unknown };
}

/** Parse a `/models` response, keeping models that output transcriptions. */
export function parseTranscriptionModels(body: unknown): TranscriptionModel[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new ProviderError("OpenRouter model list has no data array", "openrouter");
  }
  const out: TranscriptionModel[] = [];
  for (const raw of data as RawModel[]) {
    const id = str(raw?.id);
    if (!id) continue;
    const modalities = raw.architecture?.output_modalities;
    if (Array.isArray(modalities) && !modalities.includes("transcription")) continue;
    const prompt = str(raw.pricing?.prompt);
    const completion = str(raw.pricing?.completion);
    out.push({
      id,
      ...(str(raw.canonical_slug) ? { canonicalSlug: str(raw.canonical_slug) } : {}),
      ...(str(raw.name) ? { name: str(raw.name) } : {}),
      pricing: { ...(prompt ? { prompt } : {}), ...(completion ? { completion } : {}) },
    });
  }
  return out;
}

/** The live list of OpenRouter transcription models (public endpoint; no key sent). */
export async function listTranscriptionModels(
  opts: { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<TranscriptionModel[]> {
  const body = await fetchJson<unknown>({
    url: `${opts.baseUrl ?? OPENROUTER_API_BASE}/models?output_modalities=transcription`,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBytes: 8 * 1024 * 1024,
    fetch: opts.fetch,
  });
  return parseTranscriptionModels(body);
}

/** Match a model id (or its dated canonical slug), ignoring case. */
export function findTranscriptionModel(
  models: TranscriptionModel[],
  id: string,
): TranscriptionModel | undefined {
  const want = id.trim().toLowerCase();
  return models.find((m) => m.id.toLowerCase() === want || m.canonicalSlug?.toLowerCase() === want);
}
