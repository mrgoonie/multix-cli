import { ValidationError } from "../../core/errors.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-transcribe";

export const OPENAI_IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const OPENAI_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export const OPENAI_IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;

export const OPENAI_TTS_OUTPUT_FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export const OPENAI_STT_MODELS = [
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe-diarize",
  "whisper-1",
] as const;

export const OPENAI_TRANSCRIPT_FORMATS = ["json", "text", "diarized_json"] as const;

export type OpenAIImageOutputFormat = (typeof OPENAI_IMAGE_OUTPUT_FORMATS)[number];
export type OpenAIImageQuality = (typeof OPENAI_IMAGE_QUALITIES)[number];
export type OpenAIImageSize = (typeof OPENAI_IMAGE_SIZES)[number];
export type OpenAITtsOutputFormat = (typeof OPENAI_TTS_OUTPUT_FORMATS)[number];
export type OpenAITtsVoice = (typeof OPENAI_TTS_VOICES)[number];
export type OpenAITranscriptFormat = (typeof OPENAI_TRANSCRIPT_FORMATS)[number];
export type OpenAIImageDriver = "api" | "codex" | "auto";

export function isOneOf<T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export function extFromImageFormat(format: OpenAIImageOutputFormat): "png" | "jpg" | "webp" {
  if (format === "jpeg") return "jpg";
  return format;
}

export function extFromAudioFormat(format: OpenAITtsOutputFormat): string {
  return format;
}

export function parseImageFormat(value: string): OpenAIImageOutputFormat {
  if (!isOneOf(value, OPENAI_IMAGE_OUTPUT_FORMATS)) {
    throw new ValidationError(`--format must be one of: ${OPENAI_IMAGE_OUTPUT_FORMATS.join(", ")}`);
  }
  return value;
}

export function parseImageQuality(value: string): OpenAIImageQuality {
  if (!isOneOf(value, OPENAI_IMAGE_QUALITIES)) {
    throw new ValidationError(`--quality must be one of: ${OPENAI_IMAGE_QUALITIES.join(", ")}`);
  }
  return value;
}

export function parseImageSize(value: string): OpenAIImageSize {
  if (!isOneOf(value, OPENAI_IMAGE_SIZES)) {
    throw new ValidationError(`--size must be one of: ${OPENAI_IMAGE_SIZES.join(", ")}`);
  }
  return value;
}

export function parseDriver(value: string): OpenAIImageDriver {
  if (!isOneOf(value, ["api", "codex", "auto"] as const)) {
    throw new ValidationError("--driver must be one of: api, codex, auto");
  }
  return value;
}

export function parseNumImages(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError("--num-images must be an integer from 1 to 10");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 10) {
    throw new ValidationError("--num-images must be an integer from 1 to 10");
  }
  return parsed;
}

export function parseTtsFormat(value: string): OpenAITtsOutputFormat {
  if (!isOneOf(value, OPENAI_TTS_OUTPUT_FORMATS)) {
    throw new ValidationError(
      `--output-format must be one of: ${OPENAI_TTS_OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return value;
}

export function validateTtsVoice(value: string): void {
  if (!isOneOf(value, OPENAI_TTS_VOICES)) {
    throw new ValidationError(`--voice must be one of: ${OPENAI_TTS_VOICES.join(", ")}`);
  }
}

export function parseTranscriptFormat(value: string): OpenAITranscriptFormat {
  if (!isOneOf(value, OPENAI_TRANSCRIPT_FORMATS)) {
    throw new ValidationError(`--format must be one of: ${OPENAI_TRANSCRIPT_FORMATS.join(", ")}`);
  }
  return value;
}

export function resolveTranscriptionRequestFormat(
  cliFormat: OpenAITranscriptFormat,
  model: string,
): "json" | "diarized_json" {
  if (cliFormat === "diarized_json") {
    if (model !== "gpt-4o-transcribe-diarize") {
      throw new ValidationError("--format diarized_json requires gpt-4o-transcribe-diarize");
    }
    return "diarized_json";
  }
  return "json";
}

export function validateKnownSpeakerPairing(names: string[] = [], refs: string[] = []): void {
  if (names.length !== refs.length) {
    throw new ValidationError(
      "--known-speaker-name and --known-speaker-reference must have equal counts",
    );
  }
  if (names.length > 4) {
    throw new ValidationError("OpenAI diarization supports up to 4 known speakers");
  }
}
