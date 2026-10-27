/**
 * Fish Audio text-to-speech client (runtime-neutral: no `node:*` imports; the
 * caller passes `fetch` and the API key).
 *
 * POST /v1/tts returns the audio bytes. The model is chosen by the `model`
 * header: a missing or misspelled value is served and billed as s2.1-pro with
 * a normal 200, and the response names no model, so the header is built only
 * from the allowlist and reported as sent, never as confirmed.
 *
 * The POST is never retried: a second request is a second paid generation.
 * Errors come back as JSON `{status, message}`.
 * Docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

import {
  HttpError,
  MultixError,
  ProviderError,
  ResponseTooLargeError,
  ValidationError,
} from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, parseRetryAfter } from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import {
  NOT_SENT_CODES,
  UNKNOWN_REMOTE_STATE,
  errorCodes,
  readCappedBytes,
  readCappedText,
} from "../../core/response-read.js";
import { FISH_API_BASE, FISH_TTS_MODELS, type FishTtsModel, isFishTtsModel } from "./models.js";
import type { FishTtsBody } from "./tts-request.js";

const ERROR_BODY_MAX = 64 * 1024;
const SNIPPET_MAX = 500;

export interface FishSpeechOptions {
  apiKey: string;
  model: FishTtsModel;
  body: FishTtsBody;
  /** Abort and fail once the audio exceeds this many bytes. */
  maxBytes: number;
  /** Whole request, audio included. Default 300 s. */
  timeoutMs?: number;
  /** Give up when no audio bytes arrive for this long once the response started. Default 60 s. */
  idleTimeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface FishSpeechAudio {
  audio: Uint8Array;
  /** Content-Type Fish sent, lower-cased, without parameters. */
  mime?: string;
  /** The exact `model` header value that was sent. */
  modelHeaderSent: FishTtsModel;
}

/** Field and message of each validation error; never the `input` value, which may echo the text. */
function validationDetail(detail: unknown[]): string {
  return detail
    .map((d) => {
      const e = d as { loc?: unknown; msg?: unknown } | null;
      const loc = Array.isArray(e?.loc) ? e.loc.join(".") : "";
      const msg = typeof e?.msg === "string" ? e.msg : "invalid";
      return loc ? `${loc}: ${msg}` : msg;
    })
    .join("; ");
}

/** Fish's error text from a JSON error body (`{status, message, reason?}`), capped. */
export function fishErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; detail?: unknown; reason?: unknown };
    const msg =
      typeof parsed?.message === "string"
        ? parsed.message
        : typeof parsed?.detail === "string"
          ? parsed.detail
          : Array.isArray(parsed?.detail)
            ? validationDetail(parsed.detail)
            : undefined;
    if (msg) {
      const reason = typeof parsed.reason === "string" ? ` (${parsed.reason})` : "";
      return `${msg}${reason}`.slice(0, SNIPPET_MAX);
    }
  } catch {}
  return text.slice(0, SNIPPET_MAX);
}

/** True when the body is Fish's own JSON error: a definite answer that nothing was generated. */
export function isFishError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed.message !== undefined || parsed.detail !== undefined || parsed.status !== undefined)
    );
  } catch {
    return false;
  }
}

const USAGE_CHECK =
  "so it may be billed: check your Fish Audio usage at https://fish.audio/app/ before sending it again";

/**
 * A paid Fish request cut off after it may have been accepted (`what`:
 * "speech", "voice design", ...). `consequence` replaces the billing advice
 * when the risk is something else, such as a duplicate voice.
 */
export function fishUnknownState(
  what: string,
  reason: string,
  cause?: unknown,
  consequence: string = USAGE_CHECK,
): MultixError {
  return new MultixError(
    `Fish Audio ${what} request was cut off (${reason}) after it may have been accepted, ${consequence}.`,
    UNKNOWN_REMOTE_STATE,
    cause === undefined ? undefined : { cause },
  );
}

/** Map a fetch failure: proven not sent -> the plain error; otherwise UNKNOWN_REMOTE_STATE. */
export function fishFetchFailure(
  cause: unknown,
  url: string,
  what: string,
  consequence?: string,
): Error {
  if (cause instanceof MultixError) return cause;
  const mapped = toFetchError(cause, url, { provider: "fish" });
  const notSent = errorCodes(cause).some((c) => NOT_SENT_CODES.has(c));
  if (mapped instanceof HttpError && !notSent) {
    return fishUnknownState(what, mapped.snippet || "connection lost", cause, consequence);
  }
  return mapped;
}

export function fishHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export interface FishPostOnce {
  url: string;
  /** Request name used in errors ("speech", "voice design", ...). */
  what: string;
  headers: Record<string, string>;
  body: string | FormData;
  signal: AbortSignal;
  /** What an unknown outcome risks; defaults to a possible charge. */
  consequence?: string;
  /**
   * The request creates something that Fish may have saved before a server
   * error, so any 5xx but 503 leaves the outcome unknown even with Fish's JSON.
   */
  creates?: boolean;
  fetch?: FetchLike;
}

/**
 * Send one paid POST (never retried) and return the 2xx response. Errors:
 * HttpError for Fish's own error answer (nothing created or billed),
 * UNKNOWN_REMOTE_STATE when the connection broke or a gateway answered
 * without saying whether Fish went on with the request.
 */
export async function postFishOnce(opts: FishPostOnce): Promise<Response> {
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      opts.url,
      { method: "POST", headers: opts.headers, body: opts.body, signal: opts.signal },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    throw fishFetchFailure(cause, opts.url, opts.what, opts.consequence);
  }
  if (!response.ok) {
    const text = await readCappedText(response, ERROR_BODY_MAX);
    // An edge page (502/504 HTML) does not say whether Fish went on; Fish's JSON does,
    // except for a creating request, which a server error can interrupt after the save.
    const serverError = response.status >= 500;
    if (
      (serverError && !isFishError(text)) ||
      (serverError && opts.creates && response.status !== 503)
    ) {
      throw fishUnknownState(
        opts.what,
        `HTTP ${response.status} from the gateway`,
        undefined,
        opts.consequence,
      );
    }
    throw new HttpError(
      response.status,
      fishErrorMessage(text),
      opts.url,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return response;
}

/**
 * Synthesize speech. Errors: ValidationError for a model outside the
 * allowlist (nothing sent), HttpError for a non-2xx answer, ProviderError for
 * a 2xx answer that carries no audio, ResponseTooLargeError past `maxBytes`,
 * and UNKNOWN_REMOTE_STATE when the connection broke after the request may
 * have reached Fish.
 */
export async function createFishSpeech(opts: FishSpeechOptions): Promise<FishSpeechAudio> {
  // Guard the header even for callers that skipped the CLI checks.
  if (!isFishTtsModel(opts.model)) {
    throw new ValidationError(
      `Fish Audio TTS model must be one of ${FISH_TTS_MODELS.join(", ")} (got "${String(opts.model)}"); any other value is billed as s2.1-pro`,
    );
  }
  const url = `${opts.baseUrl ?? FISH_API_BASE}/v1/tts`;
  const response = await postFishOnce({
    url,
    what: "speech",
    headers: {
      ...fishHeaders(opts.apiKey),
      "Content-Type": "application/json",
      model: opts.model,
    },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    fetch: opts.fetch,
  });

  const mime =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || undefined;
  if (mime && /json|text\/html/.test(mime)) {
    const text = await readCappedText(response, ERROR_BODY_MAX);
    throw new ProviderError(
      `Fish Audio returned ${mime} instead of audio for ${opts.model}: ${fishErrorMessage(text)}`,
      "fish",
    );
  }

  let audio: Uint8Array;
  try {
    audio = await readCappedBytes(response, opts.maxBytes, opts.idleTimeoutMs ?? 60_000, url);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      err.message += "; the generation is still billed by Fish Audio";
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw fishUnknownState("speech", `audio stream failed: ${reason}`, err);
  }
  if (audio.byteLength === 0) {
    throw new ProviderError(`Fish Audio returned no audio (0 bytes) for ${opts.model}`, "fish");
  }
  return { audio, ...(mime ? { mime } : {}), modelHeaderSent: opts.model };
}
