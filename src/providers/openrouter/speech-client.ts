/**
 * OpenRouter text-to-speech client (runtime-neutral: no node:* imports; the
 * caller passes `fetch` and the request headers, which carry the key).
 *
 * - POST /api/v1/audio/speech returns raw audio bytes (mp3 or 16-bit pcm),
 *   never JSON, with the generation id in `X-Generation-Id`.
 * - GET /api/v1/models?output_modalities=speech lists the speech models and
 *   each model's `supported_voices` (public, no key).
 * - GET /api/v1/generation?id= reports the resolved model, provider and cost
 *   of a finished generation; it answers 404 for a few seconds after the audio
 *   was returned.
 *
 * The POST is never retried: a second request is a second paid generation.
 * Docs: https://openrouter.ai/docs/api/api-reference/tts/create-speech
 */

import { HttpError, MultixError, ProviderError, ResponseTooLargeError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson, parseRetryAfter } from "../../core/fetch-json.js";
import {
  NOT_SENT_CODES,
  UNKNOWN_REMOTE_STATE,
  errorCodes,
  readAudio,
  readCappedText,
} from "../../core/http-body.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import { type AudioContentType, parseAudioContentType } from "./speech-audio.js";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export { DEFAULT_OPENROUTER_TTS_MODEL } from "./speech-defaults.js";
// Moved to core so other providers need not import OpenRouter; re-exported for existing callers.
export { NOT_SENT_CODES, UNKNOWN_REMOTE_STATE, errorCodes, readCappedText };

const ERROR_BODY_MAX = 64 * 1024;
const SNIPPET_MAX = 500;
const GENERATION_ID = /^[\w.:-]{1,128}$/;

/** One turn of multi-speaker input (Gemini TTS, Fish Audio except S1). */
export interface SpeechTurn {
  text: string;
  voice?: string;
  instructions?: string;
}

export interface SpeechRequestBody {
  model: string;
  input: string | SpeechTurn[];
  voice?: string;
  instructions?: string;
  response_format: "mp3" | "pcm";
  speed?: number;
  provider?: {
    zdr?: boolean;
    data_collection?: "allow" | "deny";
    options?: Record<string, unknown>;
  };
}

export interface CreateSpeechOptions {
  body: SpeechRequestBody;
  /** Request headers, Authorization included. */
  headers: Record<string, string>;
  /** Abort and fail once the audio exceeds this many bytes. */
  maxBytes: number;
  /** Whole request, audio included. Default 300 s. */
  timeoutMs?: number;
  /** Give up when no audio bytes arrive for this long once the response started. Default 60 s. */
  idleTimeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface SpeechAudio {
  audio: Uint8Array;
  /** Parsed Content-Type (mime, pcm rate and channels when OpenRouter states them). */
  contentType: AudioContentType;
  generationId?: string;
  /** `X-Provider-Name`, when OpenRouter sent it. */
  providerName?: string;
}

/** True when the body is OpenRouter's own JSON error (`{"error": ...}`): a definite answer. */
export function isOpenRouterError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed !== null && typeof parsed === "object" && parsed.error !== undefined;
  } catch {
    return false;
  }
}

/** OpenRouter's error message from an error body, capped. */
export function errorMessageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const err = parsed?.error;
    const msg =
      typeof err === "string" ? err : typeof err?.message === "string" ? err.message : undefined;
    if (msg) return msg.slice(0, SNIPPET_MAX);
    if (typeof parsed?.message === "string") return parsed.message.slice(0, SNIPPET_MAX);
  } catch {}
  return text.slice(0, SNIPPET_MAX);
}

/** A paid request cut off after it may have reached OpenRouter (`kind`: speech, transcription). */
export function unknownState(
  model: string,
  reason: string,
  generationId?: string,
  cause?: unknown,
  kind = "speech",
) {
  const check = generationId
    ? `check it with \`multix openrouter generation ${generationId}\``
    : "check https://openrouter.ai/activity";
  return new MultixError(
    `OpenRouter ${kind} request for ${model} was cut off (${reason}) after it may have been accepted, so it may be billed: ${check} before sending it again.`,
    UNKNOWN_REMOTE_STATE,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Synthesize speech. Errors: HttpError for a non-2xx answer (message =
 * OpenRouter's error text), ProviderError for a 2xx answer that carries no
 * audio, ResponseTooLargeError past `maxBytes`, and UNKNOWN_REMOTE_STATE when
 * the connection broke after the request may have reached OpenRouter.
 */
export async function createSpeech(opts: CreateSpeechOptions): Promise<SpeechAudio> {
  const url = `${opts.baseUrl ?? OPENROUTER_API_BASE}/audio/speech`;
  const model = opts.body.model;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      url,
      {
        method: "POST",
        headers: { ...opts.headers, "Content-Type": "application/json" },
        body: JSON.stringify(opts.body),
        signal,
      },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    if (cause instanceof MultixError) throw cause;
    const mapped = toFetchError(cause, url, { provider: "openrouter" });
    const notSent = errorCodes(cause).some((c) => NOT_SENT_CODES.has(c));
    if (mapped instanceof HttpError && !notSent) {
      throw unknownState(model, mapped.snippet || "connection lost", undefined, cause);
    }
    throw mapped;
  }

  const rawId = response.headers.get("x-generation-id")?.trim();
  const generationId = rawId && GENERATION_ID.test(rawId) ? rawId : undefined;
  const providerName = response.headers.get("x-provider-name")?.trim().slice(0, 100) || undefined;
  const rawType = response.headers.get("content-type");
  const contentType = parseAudioContentType(rawType);

  if (!response.ok) {
    const text = await readCappedText(response, ERROR_BODY_MAX);
    // A gateway page (502/504/524 HTML from the edge) does not say whether the
    // generation went on and was billed; OpenRouter's own JSON error does.
    if (response.status >= 500 && !isOpenRouterError(text)) {
      throw unknownState(model, `HTTP ${response.status} from the gateway`, generationId);
    }
    throw new HttpError(
      response.status,
      errorMessageOf(text),
      url,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (contentType.mime && /json|text\/html/.test(contentType.mime)) {
    const text = await readCappedText(response, ERROR_BODY_MAX);
    throw new ProviderError(
      `OpenRouter returned ${contentType.mime} instead of audio for ${model}: ${errorMessageOf(text)}`,
      "openrouter",
    );
  }

  let audio: Uint8Array;
  try {
    audio = await readAudio(response, opts.maxBytes, opts.idleTimeoutMs ?? 60_000, url);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      // The generation is done (and billed) even though its audio was dropped.
      if (generationId) {
        err.message += `; generation ${generationId} may still be billed: multix openrouter generation ${generationId}`;
      }
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw unknownState(model, `audio stream failed: ${reason}`, generationId, err);
  }
  if (audio.byteLength === 0) {
    throw new ProviderError(
      `OpenRouter returned no audio (0 bytes) for ${model}${generationId ? ` (generation ${generationId})` : ""}`,
      "openrouter",
    );
  }
  return {
    audio,
    contentType,
    ...(generationId ? { generationId } : {}),
    ...(providerName ? { providerName } : {}),
  };
}

export interface SpeechModel {
  id: string;
  canonicalSlug?: string;
  name?: string;
  /** Voice ids OpenRouter lists for the model; empty when it lists none. */
  voices: string[];
  /** USD per input character (most models) or per output second (`completion`, e.g. Seed Audio). */
  pricing: { prompt?: string; completion?: string };
}

interface RawModel {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  supported_voices?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { output_modalities?: unknown };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse a `/models` response, keeping models that output speech. */
export function parseSpeechModels(body: unknown): SpeechModel[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    throw new ProviderError("OpenRouter model list has no data array", "openrouter");
  }
  const out: SpeechModel[] = [];
  for (const raw of data as RawModel[]) {
    const id = str(raw?.id);
    if (!id) continue;
    const modalities = raw.architecture?.output_modalities;
    if (Array.isArray(modalities) && !modalities.includes("speech")) continue;
    const voices = Array.isArray(raw.supported_voices)
      ? raw.supported_voices.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    const prompt = str(raw.pricing?.prompt);
    const completion = str(raw.pricing?.completion);
    out.push({
      id,
      ...(str(raw.canonical_slug) ? { canonicalSlug: str(raw.canonical_slug) } : {}),
      ...(str(raw.name) ? { name: str(raw.name) } : {}),
      voices,
      pricing: { ...(prompt ? { prompt } : {}), ...(completion ? { completion } : {}) },
    });
  }
  return out;
}

/** The live list of OpenRouter speech models (public endpoint; no key sent). */
export async function listSpeechModels(
  opts: { baseUrl?: string; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<SpeechModel[]> {
  const body = await fetchJson<unknown>({
    url: `${opts.baseUrl ?? OPENROUTER_API_BASE}/models?output_modalities=speech`,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBytes: 8 * 1024 * 1024,
    fetch: opts.fetch,
  });
  return parseSpeechModels(body);
}

/** Match a model id (or its dated canonical slug), ignoring case. */
export function findSpeechModel(models: SpeechModel[], id: string): SpeechModel | undefined {
  const want = id.trim().toLowerCase();
  return models.find((m) => m.id.toLowerCase() === want || m.canonicalSlug?.toLowerCase() === want);
}

/**
 * The catalog spelling of `voice` for `model`, matched ignoring case. A model
 * with no listed voices takes any voice (OpenRouter decides). Returns
 * undefined for a voice the model does not list.
 */
export function matchVoice(model: SpeechModel, voice: string): string | undefined {
  if (model.voices.length === 0) return voice;
  const want = voice.trim().toLowerCase();
  return model.voices.find((v) => v.toLowerCase() === want);
}

export interface GenerationStats {
  id: string;
  /** Resolved model version (OpenRouter permaslug, e.g. `...-20260922`). */
  model?: string;
  providerName?: string;
  /** USD charged to the OpenRouter account. */
  totalCost?: number;
  /** USD billed by the upstream provider (BYOK). */
  upstreamCost?: number;
  isByok?: boolean;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseGeneration(body: unknown): GenerationStats | undefined {
  const d = (body as { data?: Record<string, unknown> } | undefined)?.data;
  const id = str(d?.id);
  if (!d || !id) return undefined;
  const stats: GenerationStats = { id };
  const model = str(d.model);
  const provider = str(d.provider_name);
  if (model) stats.model = model;
  if (provider) stats.providerName = provider;
  const pairs: Array<[keyof GenerationStats, unknown]> = [
    ["totalCost", d.total_cost],
    ["upstreamCost", d.upstream_inference_cost],
    ["tokensPrompt", d.tokens_prompt],
    ["tokensCompletion", d.tokens_completion],
    ["latencyMs", d.latency],
  ];
  for (const [key, value] of pairs) {
    const n = num(value);
    if (n !== undefined) (stats as unknown as Record<string, number>)[key] = n;
  }
  if (typeof d.is_byok === "boolean") stats.isByok = d.is_byok;
  return stats;
}

/**
 * Stats of one generation, or undefined while OpenRouter has not recorded it
 * yet (404). A read-only GET, so callers may poll it.
 */
export async function getGeneration(opts: {
  id: string;
  headers: Record<string, string>;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<GenerationStats | undefined> {
  try {
    const body = await fetchJson<unknown>({
      url: `${opts.baseUrl ?? OPENROUTER_API_BASE}/generation?id=${encodeURIComponent(opts.id)}`,
      headers: opts.headers,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: 1024 * 1024,
      fetch: opts.fetch,
    });
    return parseGeneration(body);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return undefined;
    throw err;
  }
}
