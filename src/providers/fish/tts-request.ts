/**
 * Build and check a Fish Audio /v1/tts request body (runtime-neutral: no
 * `node:*` imports). The text is sent exactly as given: direction tags
 * (`[whispering]`), paired tags and phoneme tags are Fish syntax and are never
 * stripped or rewritten. Multi-speaker text uses `<|speaker:N|>` tags whose N
 * indexes the `reference_id` array.
 * Docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 */

import { ValidationError } from "../../core/errors.js";
import {
  FISH_LATENCIES,
  FISH_MAX_SPEAKERS,
  FISH_MAX_TEXT_BYTES,
  FISH_MP3_BITRATES,
  FISH_MULTI_SPEAKER_MODELS,
  FISH_PUBLIC_VOICES,
  FISH_SAMPLE_RATES,
  type FishTtsFormat,
  type FishTtsModel,
} from "./models.js";

export const OPUS_BITRATES = [-1000, 24_000, 32_000, 48_000, 64_000] as const;
const PHONEME_START = "<|phoneme_start|>";
const PHONEME_END = "<|phoneme_end|>";
const SPEAKER_TAG = /<\|speaker:(\d+)\|>/g;
const VOICE_REF = /^[A-Za-z0-9_-]{1,128}$/;
const DICTIONARY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const MAX_DICTIONARIES = 3;
export const MAX_DICTIONARY_ITEMS = 5000;
const MAX_KEY_CHARS = 256;
const MAX_VALUE_CHARS = 1024;

export interface PronunciationItem {
  key: string;
  value: string;
  case_sensitive?: boolean;
}
export interface PronunciationDictionaryRef {
  id: string;
  version: string;
}
export interface PronunciationDictionaryInline {
  items: PronunciationItem[];
}
/** Either every entry is a published reference or every entry is inline; Fish rejects a mix. */
export type PronunciationDictionaries =
  | PronunciationDictionaryRef[]
  | PronunciationDictionaryInline[];

export interface FishTtsBody {
  text: string;
  reference_id?: string | string[];
  format: FishTtsFormat;
  sample_rate?: number;
  mp3_bitrate?: number;
  opus_bitrate?: number;
  temperature?: number;
  top_p?: number;
  prosody?: { speed?: number; volume?: number; normalize_loudness?: boolean };
  chunk_length?: number;
  normalize?: boolean;
  language?: string;
  latency?: (typeof FISH_LATENCIES)[number];
  pronunciation_dictionary?: PronunciationDictionaries;
}

export interface FishTtsInput {
  model: FishTtsModel;
  text: string;
  /** Voice model ids (or public voice names); one per speaker in multi-speaker text. */
  voices: string[];
  format: FishTtsFormat;
  sampleRate?: number;
  mp3Bitrate?: number;
  opusBitrate?: number;
  temperature?: number;
  topP?: number;
  speed?: number;
  volume?: number;
  normalizeLoudness?: boolean;
  chunkLength?: number;
  normalize?: boolean;
  language?: string;
  latency?: string;
  dictionaries?: PronunciationDictionaries;
}

export interface FishTtsPlan {
  body: FishTtsBody;
  /** UTF-8 bytes of `text`, the unit Fish bills. */
  utf8Bytes: number;
  /** Speaker indexes used in the text (empty for single-speaker text). */
  speakers: number[];
  warnings: string[];
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A public voice name (adrian, delia, sheila) becomes its id; anything else is checked and kept. */
export function resolveFishVoice(voice: string): string {
  const v = voice.trim();
  const named = FISH_PUBLIC_VOICES[v.toLowerCase()];
  if (named) return named;
  if (!VOICE_REF.test(v)) {
    throw new ValidationError(
      `"${voice}" is not a Fish Audio voice id (letters, digits, _ and - only, e.g. ${FISH_PUBLIC_VOICES.adrian}). List your voices with: multix fish voices list`,
    );
  }
  return v;
}

/** Speaker indexes named by `<|speaker:N|>` tags, in first-use order. */
export function speakerIndexes(text: string): number[] {
  const seen: number[] = [];
  for (const match of text.matchAll(SPEAKER_TAG)) {
    const n = Number(match[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

function range(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be between ${min} and ${max} (got ${value})`);
  }
}

/** Multi-speaker turns as one tagged text: `<|speaker:0|>Hello<|speaker:1|>Hi`. */
export function turnsToSpeakerText(turns: Array<{ text: string; voice: string }>): {
  text: string;
  voices: string[];
} {
  const voices: string[] = [];
  let text = "";
  for (const [i, turn] of turns.entries()) {
    if (turn.text.trim() === "") throw new ValidationError(`Turn ${i + 1} has no text`);
    const voice = resolveFishVoice(turn.voice);
    let index = voices.indexOf(voice);
    if (index < 0) {
      index = voices.push(voice) - 1;
    }
    text += `<|speaker:${index}|>${turn.text}`;
  }
  return { text, voices };
}

/**
 * Check a `pronunciation_dictionary` value: at most three dictionaries, all
 * references (`{id, version}` with a pinned version) or all inline
 * (`{items}`), never mixed, and no phoneme markers in keys or values.
 */
export function validateDictionaries(value: unknown): PronunciationDictionaries {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DICTIONARIES) {
    throw new ValidationError(
      `A pronunciation dictionary list holds 1 to ${MAX_DICTIONARIES} dictionaries`,
    );
  }
  const isRef = (d: unknown) =>
    Boolean(d) && typeof d === "object" && "id" in (d as object) && !("items" in (d as object));
  const refs = value.filter(isRef).length;
  if (refs > 0 && refs < value.length) {
    throw new ValidationError(
      "Pronunciation dictionaries cannot mix published references ({id, version}) and inline dictionaries ({items}) in one request",
    );
  }
  if (refs > 0) {
    return value.map((d, i) => {
      const { id, version, ...rest } = d as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        throw new ValidationError(
          `Dictionary ${i + 1}: unexpected field(s) ${Object.keys(rest).join(", ")}`,
        );
      }
      if (typeof id !== "string" || !DICTIONARY_ID.test(id)) {
        throw new ValidationError(`Dictionary ${i + 1}: "id" must match [A-Za-z0-9_-]{1,128}`);
      }
      if (typeof version !== "string" || !DICTIONARY_ID.test(version)) {
        throw new ValidationError(
          `Dictionary ${id}: "version" must be the published version id copied from the Fish Audio web app`,
        );
      }
      if (version.toLowerCase() === "latest" || /^v\d+$/i.test(version)) {
        throw new ValidationError(
          `Dictionary ${id}: pin a published version id, not "${version}" (Fish has no implicit latest and does not accept display numbers)`,
        );
      }
      return { id, version };
    });
  }
  return value.map((d, i) => {
    const dict = d as { items?: unknown } | null;
    if (!dict || typeof dict !== "object" || !Array.isArray(dict.items)) {
      throw new ValidationError(
        `Dictionary ${i + 1} must be {"id","version"} or {"items": [{"key","value","case_sensitive"?}]}`,
      );
    }
    if (Object.keys(dict).some((k) => k !== "items")) {
      throw new ValidationError(
        `Dictionary ${i + 1}: only "items" is allowed in an inline dictionary`,
      );
    }
    if (dict.items.length === 0 || dict.items.length > MAX_DICTIONARY_ITEMS) {
      throw new ValidationError(`Dictionary ${i + 1} must hold 1 to ${MAX_DICTIONARY_ITEMS} items`);
    }
    const items = dict.items.map((raw, j) => {
      const item = raw as Record<string, unknown> | null;
      const where = `Dictionary ${i + 1} item ${j + 1}`;
      if (!item || typeof item.key !== "string" || typeof item.value !== "string") {
        throw new ValidationError(`${where} needs "key" and "value" strings`);
      }
      const { key, value: val, case_sensitive, ...rest } = item;
      if (Object.keys(rest).length > 0) {
        throw new ValidationError(`${where}: unexpected field(s) ${Object.keys(rest).join(", ")}`);
      }
      if (key.length === 0 || key.length > MAX_KEY_CHARS) {
        throw new ValidationError(`${where}: "key" must be 1 to ${MAX_KEY_CHARS} characters`);
      }
      if (val.length === 0 || val.length > MAX_VALUE_CHARS) {
        throw new ValidationError(`${where}: "value" must be 1 to ${MAX_VALUE_CHARS} characters`);
      }
      for (const text of [key, val]) {
        if (text.includes(PHONEME_START) || text.includes(PHONEME_END)) {
          throw new ValidationError(
            `${where}: keys and values must not contain ${PHONEME_START} or ${PHONEME_END} (Fish wraps values itself)`,
          );
        }
      }
      if (case_sensitive !== undefined && typeof case_sensitive !== "boolean") {
        throw new ValidationError(`${where}: "case_sensitive" must be true or false`);
      }
      return {
        key,
        value: val,
        ...(case_sensitive !== undefined ? { case_sensitive } : {}),
      };
    });
    return { items };
  });
}

/** `id@version` from the command line. */
export function parseDictionaryRef(spec: string): PronunciationDictionaryRef {
  const at = spec.indexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new ValidationError(
      `--dictionary must be <dictionary-id>@<version-id> with a pinned version (got "${spec}")`,
    );
  }
  return { id: spec.slice(0, at).trim(), version: spec.slice(at + 1).trim() };
}

/** Validate a TTS input and build the body to send; nothing is sent here. */
export function planFishTts(input: FishTtsInput): FishTtsPlan {
  const warnings: string[] = [];
  const { text, model, format } = input;
  if (text.trim() === "") throw new ValidationError("The text to speak is empty");
  const utf8Bytes = utf8Length(text);
  if (utf8Bytes > FISH_MAX_TEXT_BYTES) {
    throw new ValidationError(
      `The text is ${utf8Bytes} UTF-8 bytes; multix sends at most ${FISH_MAX_TEXT_BYTES} per request (split it)`,
    );
  }
  const starts = text.split(PHONEME_START).length - 1;
  const ends = text.split(PHONEME_END).length - 1;
  if (starts !== ends) {
    warnings.push(
      `The text has ${starts} ${PHONEME_START} and ${ends} ${PHONEME_END} tags; unbalanced phoneme tags may be read aloud`,
    );
  }

  const voices = input.voices.map(resolveFishVoice);
  const speakers = speakerIndexes(text);
  if (speakers.length > 0 || voices.length > 1) {
    if (!FISH_MULTI_SPEAKER_MODELS.includes(model)) {
      throw new ValidationError(
        `${model} speaks with one voice; multi-speaker text needs ${FISH_MULTI_SPEAKER_MODELS.join(", ")}`,
      );
    }
    if (speakers.length === 0) {
      throw new ValidationError(
        `${voices.length} voices were given but the text has no <|speaker:N|> tags; tag each turn, or use --turns-file`,
      );
    }
    if (voices.length > FISH_MAX_SPEAKERS) {
      throw new ValidationError(`At most ${FISH_MAX_SPEAKERS} speakers per request`);
    }
    const top = Math.max(...speakers);
    if (top >= voices.length) {
      throw new ValidationError(
        `The text uses <|speaker:${top}|> but only ${voices.length} voice(s) were given; give one --voice per speaker, in index order`,
      );
    }
    if (voices.length > speakers.length) {
      warnings.push(`${voices.length - speakers.length} voice(s) are not used by any speaker tag`);
    }
  }

  range("--temperature", input.temperature, 0, 1);
  range("--top-p", input.topP, 0, 1);
  range("--speed", input.speed, 0.5, 2);
  if (input.volume !== undefined && !Number.isFinite(input.volume)) {
    throw new ValidationError("--volume must be a number of dB (0 = unchanged)");
  }
  range("--chunk-length", input.chunkLength, 100, 300);
  if (input.chunkLength !== undefined && !Number.isInteger(input.chunkLength)) {
    throw new ValidationError("--chunk-length must be a whole number");
  }
  if (input.sampleRate !== undefined && !FISH_SAMPLE_RATES[format].includes(input.sampleRate)) {
    throw new ValidationError(
      format === "opus"
        ? "Opus output is 48000 Hz; drop --sample-rate"
        : `--sample-rate for ${format} must be one of ${FISH_SAMPLE_RATES[format].join(", ")}`,
    );
  }
  if (input.mp3Bitrate !== undefined) {
    if (format !== "mp3") throw new ValidationError("--mp3-bitrate applies to --format mp3 only");
    if (!(FISH_MP3_BITRATES as readonly number[]).includes(input.mp3Bitrate)) {
      throw new ValidationError(`--mp3-bitrate must be one of ${FISH_MP3_BITRATES.join(", ")}`);
    }
  }
  if (input.opusBitrate !== undefined) {
    if (format !== "opus")
      throw new ValidationError("--opus-bitrate applies to --format opus only");
    if (!(OPUS_BITRATES as readonly number[]).includes(input.opusBitrate)) {
      throw new ValidationError(
        `--opus-bitrate must be one of ${OPUS_BITRATES.join(", ")} (-1000 = automatic)`,
      );
    }
  }
  if (input.language !== undefined && !/^[A-Za-z0-9_-]{1,35}$/.test(input.language)) {
    throw new ValidationError("--language must be a BCP-47 tag such as en, vi or es-MX");
  }
  if (
    input.latency !== undefined &&
    !(FISH_LATENCIES as readonly string[]).includes(input.latency)
  ) {
    throw new ValidationError(`--latency must be one of ${FISH_LATENCIES.join(", ")}`);
  }
  const dictionaries = input.dictionaries ? validateDictionaries(input.dictionaries) : undefined;
  if (dictionaries && "id" in (dictionaries[0] ?? {})) {
    warnings.push(
      "Fish skips a dictionary reference it cannot resolve and still returns audio: a 200 does not prove the dictionary was applied",
    );
  }

  const prosody = {
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
    ...(input.volume !== undefined ? { volume: input.volume } : {}),
    ...(input.normalizeLoudness !== undefined
      ? { normalize_loudness: input.normalizeLoudness }
      : {}),
  };
  const body: FishTtsBody = {
    text,
    format,
    ...(voices.length === 1 && speakers.length === 0 ? { reference_id: voices[0] } : {}),
    ...(voices.length > 0 && (speakers.length > 0 || voices.length > 1)
      ? { reference_id: voices }
      : {}),
    ...(input.sampleRate !== undefined ? { sample_rate: input.sampleRate } : {}),
    ...(input.mp3Bitrate !== undefined ? { mp3_bitrate: input.mp3Bitrate } : {}),
    ...(input.opusBitrate !== undefined ? { opus_bitrate: input.opusBitrate } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(Object.keys(prosody).length > 0 ? { prosody } : {}),
    ...(input.chunkLength !== undefined ? { chunk_length: input.chunkLength } : {}),
    ...(input.normalize !== undefined ? { normalize: input.normalize } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.latency !== undefined
      ? { latency: input.latency as (typeof FISH_LATENCIES)[number] }
      : {}),
    ...(dictionaries ? { pronunciation_dictionary: dictionaries } : {}),
  };
  return { body, utf8Bytes, speakers, warnings };
}
