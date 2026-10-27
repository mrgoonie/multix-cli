/**
 * Fish Audio voice design client (runtime-neutral: no `node:*` imports; the
 * caller passes `fetch` and the API key).
 *
 * POST /v1/voice-design turns a text description into 1 to 4 candidate voices,
 * returned as base64 WAV in one JSON response. The `model: voice-design-1`
 * header is required and extra body fields are rejected. One successful
 * request is billed once, however many candidates it returns, so the POST is
 * never retried. Nothing is stored on Fish: keep a candidate by saving its
 * audio and cloning it with `fish voices create`.
 * Docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/voice-design
 */

import {
  HttpError,
  ProviderError,
  ResponseTooLargeError,
  ValidationError,
} from "../../core/errors.js";
import { type FetchLike, parseRetryAfter } from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import { readCappedBytes, readCappedText } from "../../core/response-read.js";
import { FISH_API_BASE, FISH_VOICE_DESIGN_MODEL } from "./models.js";
import {
  fishErrorMessage,
  fishFetchFailure,
  fishHeaders,
  fishUnknownState,
  isFishError,
} from "./tts-client.js";

const ERROR_BODY_MAX = 64 * 1024;
const INSTRUCTION_MAX = 2000;
/** The guide allows 300 characters; the API schema says 150. Fish rejects (unbilled) what it does not take. */
const REFERENCE_TEXT_MAX = 300;
export const FISH_VOICE_DESIGN_MAX_CANDIDATES = 4;

export interface FishVoiceDesignInput {
  instruction: string;
  referenceText?: string;
  language?: string;
  /** Candidates to generate, 1 to 4 (Fish default 2). */
  count?: number;
  speed?: number;
  numStep?: number;
  guidanceScale?: number;
  instructGuidanceScale?: number;
  seed?: number;
}

/** The exact JSON body /v1/voice-design accepts (no other fields). */
export interface FishVoiceDesignBody {
  instruction: string;
  reference_text?: string;
  language?: string;
  n?: number;
  speed?: number;
  num_step?: number;
  guidance_scale?: number;
  instruct_guidance_scale?: number;
  seed?: number;
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new ValidationError(message);
}

/** Validate the input and build the body; nothing is sent. */
export function planFishVoiceDesign(input: FishVoiceDesignInput): FishVoiceDesignBody {
  const instruction = input.instruction.trim();
  const chars = [...instruction].length;
  check(
    chars >= 1 && chars <= INSTRUCTION_MAX,
    `--instruction must be 1 to ${INSTRUCTION_MAX} characters (got ${chars})`,
  );
  const body: FishVoiceDesignBody = { instruction };
  if (input.referenceText !== undefined) {
    const text = input.referenceText.trim();
    const n = [...text].length;
    check(
      n >= 1 && n <= REFERENCE_TEXT_MAX,
      `--reference-text must be 1 to ${REFERENCE_TEXT_MAX} characters (got ${n})`,
    );
    body.reference_text = text;
  }
  if (input.language !== undefined) {
    check(
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language),
      "--language must be a BCP-47 code such as en, vi or es-MX",
    );
    body.language = input.language;
  }
  if (input.count !== undefined) {
    check(
      Number.isInteger(input.count) &&
        input.count >= 1 &&
        input.count <= FISH_VOICE_DESIGN_MAX_CANDIDATES,
      `--count must be a whole number from 1 to ${FISH_VOICE_DESIGN_MAX_CANDIDATES}`,
    );
    body.n = input.count;
  }
  if (input.speed !== undefined) {
    check(input.speed > 0 && input.speed <= 3, "--speed must be above 0 and at most 3");
    body.speed = input.speed;
  }
  if (input.numStep !== undefined) {
    check(
      Number.isInteger(input.numStep) && input.numStep >= 1 && input.numStep <= 128,
      "--num-step must be a whole number from 1 to 128",
    );
    body.num_step = input.numStep;
  }
  if (input.guidanceScale !== undefined) {
    check(input.guidanceScale >= 0, "--guidance-scale must be 0 or more");
    body.guidance_scale = input.guidanceScale;
  }
  if (input.instructGuidanceScale !== undefined) {
    check(input.instructGuidanceScale >= 0, "--instruct-guidance-scale must be 0 or more");
    body.instruct_guidance_scale = input.instructGuidanceScale;
  }
  if (input.seed !== undefined) {
    check(
      Number.isSafeInteger(input.seed) && input.seed >= 0,
      "--seed must be a whole number of 0 or more",
    );
    body.seed = input.seed;
  }
  return body;
}

export interface FishVoiceDesignCandidate {
  id: string | null;
  index: number;
  /** Decoded audio, or null when the candidate's payload was unusable (see `problem`). */
  audio: Uint8Array | null;
  sample_rate: number | null;
  duration_ms: number | null;
  text: string | null;
  language: string | null;
  problem: string | null;
}

export interface FishVoiceDesignOptions {
  apiKey: string;
  body: FishVoiceDesignBody;
  /** Abort once the JSON response exceeds this many bytes. */
  maxBytes: number;
  /** Cap on one decoded candidate. */
  maxCandidateBytes: number;
  /** Whole request. Default 300 s. */
  timeoutMs?: number;
  /** Give up when no bytes arrive for this long once the response started. Default 120 s. */
  idleTimeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface FishVoiceDesignResult {
  candidates: FishVoiceDesignCandidate[];
  modelHeaderSent: typeof FISH_VOICE_DESIGN_MODEL;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 decode under a byte cap; checks the size before decoding. */
export function decodeFishBase64(value: string, maxBytes: number): Uint8Array {
  const clean = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean)) {
    throw new Error("audio_base64 is not valid base64");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const size = (clean.length / 4) * 3 - padding;
  if (size > maxBytes) throw new Error(`decoded audio is larger than ${maxBytes} bytes`);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function parseCandidate(raw: unknown, i: number, maxBytes: number): FishVoiceDesignCandidate {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const index =
    typeof c.index === "number" && Number.isInteger(c.index) && c.index >= 0 ? c.index : i;
  let audio: Uint8Array | null = null;
  let problem: string | null = null;
  if (typeof c.audio_base64 !== "string") {
    problem = "no audio_base64";
  } else {
    try {
      audio = decodeFishBase64(c.audio_base64, maxBytes);
      if (audio.byteLength === 0) {
        audio = null;
        problem = "empty audio";
      }
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    id: str(c.id),
    index,
    audio,
    sample_rate: count(c.sample_rate),
    duration_ms: count(c.duration_ms),
    text: str(c.text),
    language: str(c.language),
    problem,
  };
}

/**
 * Generate candidate voices. Errors: HttpError for Fish's own non-2xx answer
 * (unbilled), ProviderError for a 2xx answer with no candidates (unbilled per
 * Fish), ResponseTooLargeError past `maxBytes` (still billed), and
 * UNKNOWN_REMOTE_STATE when the connection broke after Fish may have run it.
 * A candidate whose audio cannot be decoded is returned with `problem` set so
 * the others are kept.
 */
export async function createFishVoiceDesign(
  opts: FishVoiceDesignOptions,
): Promise<FishVoiceDesignResult> {
  const url = `${opts.baseUrl ?? FISH_API_BASE}/v1/voice-design`;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      url,
      {
        method: "POST",
        headers: {
          ...fishHeaders(opts.apiKey),
          "Content-Type": "application/json",
          model: FISH_VOICE_DESIGN_MODEL,
        },
        body: JSON.stringify(opts.body),
        signal,
      },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    throw fishFetchFailure(cause, url, "voice design");
  }

  if (!response.ok) {
    const text = await readCappedText(response, ERROR_BODY_MAX);
    if (response.status >= 500 && !isFishError(text)) {
      throw fishUnknownState("voice design", `HTTP ${response.status} from the gateway`);
    }
    throw new HttpError(
      response.status,
      fishErrorMessage(text),
      url,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  let raw: Uint8Array;
  try {
    raw = await readCappedBytes(response, opts.maxBytes, opts.idleTimeoutMs ?? 120_000, url);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      err.message += "; the voice design request is still billed by Fish Audio";
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw fishUnknownState("voice design", `response stream failed: ${reason}`, err);
  }
  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as { candidates?: unknown };
  } catch (err) {
    // A body too long for one JavaScript string is too large, not cut off.
    if (err instanceof RangeError) {
      const tooLarge = new ResponseTooLargeError(opts.maxBytes, url);
      tooLarge.message += "; the voice design request is still billed by Fish Audio";
      throw tooLarge;
    }
    throw fishUnknownState("voice design", "the 200 response is not complete JSON");
  }
  if (!Array.isArray(parsed?.candidates) || parsed.candidates.length === 0) {
    throw new ProviderError(
      "Fish Audio voice design returned no candidates (Fish does not bill an empty result); try a more specific --instruction",
      "fish",
    );
  }
  return {
    candidates: parsed.candidates.map((c, i) => parseCandidate(c, i, opts.maxCandidateBytes)),
    modelHeaderSent: FISH_VOICE_DESIGN_MODEL,
  };
}
