/**
 * Audio formats of the OpenRouter speech endpoint (runtime-neutral).
 * The endpoint returns `mp3` (audio/mpeg) or `pcm` (16-bit little-endian,
 * `audio/pcm;rate=24000;channels=1`). `wav` is a CLI format: pcm requested
 * from OpenRouter and wrapped in a WAV header locally.
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

import { ValidationError } from "../../core/errors.js";

export const SPEECH_FORMATS = ["auto", "mp3", "pcm", "wav"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];
export type ResolvedSpeechFormat = Exclude<SpeechFormat, "auto">;

/** Rate OpenRouter documents for its pcm output (Gemini, Azure); used only when the response does not say. */
export const DEFAULT_PCM_SAMPLE_RATE = 24_000;

/**
 * Model families whose OpenRouter adapter returns only one format (per the
 * TTS guide: Gemini TTS and HeyGen Voice only pcm, MiniMax only mp3). Others
 * accept both.
 */
const PCM_ONLY = /^(google|heygen)\//i;
const MP3_ONLY = /^minimax\//i;

export function parseSpeechFormat(value: string): SpeechFormat {
  const v = value.trim().toLowerCase();
  if (!(SPEECH_FORMATS as readonly string[]).includes(v)) {
    throw new ValidationError(`Invalid --format: ${value}. Valid: ${SPEECH_FORMATS.join(", ")}`);
  }
  return v as SpeechFormat;
}

/** `auto`: wav for pcm-only models, mp3 otherwise. An explicit format the model cannot return is refused. */
export function resolveSpeechFormat(format: SpeechFormat, model: string): ResolvedSpeechFormat {
  if (format === "auto") return PCM_ONLY.test(model) ? "wav" : "mp3";
  if (format === "mp3" && PCM_ONLY.test(model)) {
    throw new ValidationError(
      `${model} returns pcm only on OpenRouter: use --format wav (pcm in a WAV file) or --format pcm`,
    );
  }
  if (format !== "mp3" && MP3_ONLY.test(model)) {
    throw new ValidationError(`${model} returns mp3 only on OpenRouter: use --format mp3`);
  }
  return format;
}

/** The `response_format` sent to OpenRouter for a CLI format. */
export function requestFormat(format: ResolvedSpeechFormat): "mp3" | "pcm" {
  return format === "mp3" ? "mp3" : "pcm";
}

export interface AudioContentType {
  mime?: string;
  sampleRate?: number;
  channels?: number;
}

/** `audio/pcm;rate=24000;channels=1` -> mime, rate and channels (each only when present and valid). */
export function parseAudioContentType(value: string | null | undefined): AudioContentType {
  if (!value) return {};
  const [type = "", ...params] = value.split(";").map((p) => p.trim());
  const out: AudioContentType = {};
  if (type) out.mime = type.toLowerCase();
  for (const param of params) {
    const [key = "", raw = ""] = param.split("=").map((p) => p.trim().toLowerCase());
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if ((key === "rate" || key === "sample_rate") && n <= 384_000) out.sampleRate = n;
    if (key === "channels" && n <= 8) out.channels = n;
  }
  return out;
}

/** Bytes per second of 16-bit pcm. */
export function pcmDurationSeconds(bytes: number, sampleRate: number, channels: number): number {
  return Math.round((bytes / (sampleRate * channels * 2)) * 1000) / 1000;
}

/** Wrap 16-bit little-endian pcm in a RIFF/WAVE header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const blockAlign = channels * 2;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** True when the bytes start like an MP3 (ID3 tag or MPEG frame sync). */
export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}
