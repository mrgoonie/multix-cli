/**
 * Fish Audio voice design (runtime-neutral: no `node:*` imports; the caller
 * passes the key and `fetch`). POST /v1/voice-design with the header
 * `model: voice-design-1` returns 1-4 candidate voices as base64 WAV. It is
 * billed once per successful request, however many candidates come back, so
 * the request is sent once and never retried.
 * Docs: https://docs.fish.audio/features/voice-design
 */

import { ProviderError, ResponseTooLargeError, ValidationError } from "../../core/errors.js";
import type { FetchLike } from "../../core/fetch-json.js";
import { readCappedBytes } from "../../core/response-read.js";
import { type AudioCheck, checkFishAudio } from "./audio-check.js";
import { FISH_API_BASE, FISH_DEFAULT_SAMPLE_RATE } from "./models.js";
import { fishHeaders, fishUnknownState, postFishOnce } from "./tts-client.js";

export const VOICE_DESIGN_MODEL = "voice-design-1";
export const MAX_DESIGN_INSTRUCTION_CHARS = 2000;
/** The voice-design guide allows 300 characters; its OpenAPI schema says 150. Fish enforces its own. */
export const MAX_DESIGN_REFERENCE_CHARS = 300;
export const MAX_DESIGN_CANDIDATES = 4;

export interface VoiceDesignBody {
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

/** Check the body against the ranges Fish documents, before anything is sent. */
export function checkVoiceDesignBody(body: VoiceDesignBody): void {
  const chars = [...body.instruction.trim()].length;
  if (chars === 0 || chars > MAX_DESIGN_INSTRUCTION_CHARS) {
    throw new ValidationError(
      `The voice prompt must be 1-${MAX_DESIGN_INSTRUCTION_CHARS} characters (got ${chars})`,
    );
  }
  if (
    body.reference_text !== undefined &&
    [...body.reference_text].length > MAX_DESIGN_REFERENCE_CHARS
  ) {
    throw new ValidationError(
      `--reference-text is at most ${MAX_DESIGN_REFERENCE_CHARS} characters`,
    );
  }
  if (body.language !== undefined && !/^[A-Za-z0-9_-]{1,35}$/.test(body.language)) {
    throw new ValidationError("--language must be a language code such as en, zh, ja or vi");
  }
  const n = body.n ?? 2;
  if (!Number.isInteger(n) || n < 1 || n > MAX_DESIGN_CANDIDATES) {
    throw new ValidationError(`--count must be a whole number from 1 to ${MAX_DESIGN_CANDIDATES}`);
  }
  if (body.speed !== undefined && !(body.speed > 0 && body.speed <= 3)) {
    throw new ValidationError("--speed must be above 0 and at most 3");
  }
  if (
    body.num_step !== undefined &&
    !(Number.isInteger(body.num_step) && body.num_step >= 1 && body.num_step <= 128)
  ) {
    throw new ValidationError("--steps must be a whole number from 1 to 128");
  }
  for (const [flag, v] of [
    ["--guidance", body.guidance_scale],
    ["--instruct-guidance", body.instruct_guidance_scale],
  ] as const) {
    if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
      throw new ValidationError(`${flag} must be 0 or more`);
    }
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) {
    throw new ValidationError("--seed must be a whole number");
  }
}

export interface DesignedVoice {
  id: string;
  index: number;
  audio: Uint8Array;
  /** Sample rate Fish reported for the candidate. */
  sample_rate_hz: number;
  duration_ms: number;
  /** What the decoded bytes are (expected: WAV). */
  check: AudioCheck;
  text: string | null;
  language: string | null;
}

interface RawCandidate {
  id?: unknown;
  index?: unknown;
  audio_base64?: unknown;
  sample_rate?: unknown;
  duration_ms?: unknown;
  text?: unknown;
  language?: unknown;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode strict base64, refusing malformed text or more than `maxBytes` of output. */
export function decodeBase64Audio(value: string, maxBytes: number, label: string): Uint8Array {
  const clean = value.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean)) {
    throw new ProviderError(`Fish Audio returned invalid base64 audio for ${label}`, "fish");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const size = (clean.length / 4) * 3 - padding;
  if (size > maxBytes) {
    throw new ProviderError(
      `Fish Audio returned ${size} bytes of audio for ${label}, more than the ${maxBytes}-byte limit`,
      "fish",
    );
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const nonNegative = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export interface DesignFishVoiceOptions {
  body: VoiceDesignBody;
  apiKey: string;
  /** Cap on the whole JSON answer and on each decoded candidate. */
  maxBytes: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Called once Fish answers with a success status, which is when the request is billed. */
  onAccepted?: () => void;
}

/**
 * Generate voice candidates (one paid request, never retried). Errors:
 * ValidationError before sending, HttpError for Fish's own error answer (not
 * billed), ProviderError for an answer without valid candidates,
 * ResponseTooLargeError past `maxBytes`, UNKNOWN_REMOTE_STATE when the request
 * may have been billed but its answer was lost.
 */
export async function designFishVoice(opts: DesignFishVoiceOptions): Promise<DesignedVoice[]> {
  checkVoiceDesignBody(opts.body);
  const url = `${opts.baseUrl ?? FISH_API_BASE}/v1/voice-design`;
  const response = await postFishOnce({
    url,
    what: "voice design",
    headers: {
      ...fishHeaders(opts.apiKey),
      "Content-Type": "application/json",
      model: VOICE_DESIGN_MODEL,
    },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    fetch: opts.fetch,
  });
  // A successful status is what Fish bills, whatever the body turns out to hold.
  opts.onAccepted?.();
  let raw: Uint8Array;
  try {
    raw = await readCappedBytes(response, opts.maxBytes, opts.idleTimeoutMs ?? 60_000, url);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      err.message += "; the request is still billed by Fish Audio";
      throw err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw fishUnknownState("voice design", `answer cut off: ${reason}`, err);
  }
  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as { candidates?: unknown };
  } catch {
    throw new ProviderError(
      "Fish Audio voice design answered with something other than JSON",
      "fish",
    );
  }
  const candidates = parsed?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ProviderError("Fish Audio voice design returned no candidates", "fish");
  }
  return candidates.map((c: RawCandidate, i) => {
    const index = typeof c?.index === "number" && Number.isInteger(c.index) ? c.index : i;
    const label = `candidate ${index}`;
    if (typeof c?.audio_base64 !== "string") {
      throw new ProviderError(`Fish Audio voice design ${label} has no audio`, "fish");
    }
    const audio = decodeBase64Audio(c.audio_base64, opts.maxBytes, label);
    const rate = nonNegative(c.sample_rate) ?? FISH_DEFAULT_SAMPLE_RATE;
    return {
      id: str(c.id) ?? `candidate-${index}`,
      index,
      audio,
      sample_rate_hz: rate,
      duration_ms: nonNegative(c.duration_ms) ?? 0,
      check: checkFishAudio(audio, "wav", rate),
      text: str(c.text),
      language: str(c.language),
    };
  });
}
