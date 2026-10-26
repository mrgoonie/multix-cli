/**
 * Typed input profiles for fal text-to-speech endpoints. fal's TTS models do
 * not share one schema (Gemini reads `prompt` + `style_instructions`,
 * ElevenLabs reads `text` + `output_format`), so `fal tts` maps its flags onto
 * each endpoint's own fields and validates them before anything is queued:
 * fal accepts a malformed job and only fails it at result time.
 * Fields verified against fal's live OpenAPI schemas (2026-10-26). Any other
 * model id runs untyped: the text goes to `--text-field` and nothing else is
 * assumed. Runtime-neutral (no node:* imports).
 */

import { ValidationError } from "../../core/errors.js";

export interface FalTtsProfile {
  id: string;
  family: "gemini" | "elevenlabs";
  /** Input field that carries the spoken text. */
  textField: string;
  /** Max characters of the text field, when the schema states one. */
  maxChars?: number;
  /** Input field that, when present in --input, replaces the text (multi-speaker dialogue). */
  dialogueField?: string;
  voiceField: string;
  /** Allowed voices; absent when the endpoint takes any name or voice id. */
  voices?: readonly string[];
  defaultVoice: string;
  styleField?: string;
  formatField?: string;
  formats?: readonly string[];
  defaultFormat?: string;
  languageField?: string;
  /** Audio container the endpoint returns with its defaults. */
  output: string;
  /** Typical wall time for a short sentence (queue + inference), for discovery. */
  latency: string;
}

const GEMINI_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Pulcherrima",
  "Puck",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
] as const;

const ELEVENLABS_FORMATS = [
  "mp3_22050_32",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
  "pcm_8000",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_44100",
  "pcm_48000",
  "ulaw_8000",
  "alaw_8000",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "opus_48000_128",
  "opus_48000_192",
] as const;

function gemini(id: string): FalTtsProfile {
  return {
    id,
    family: "gemini",
    textField: "prompt",
    dialogueField: "turns",
    voiceField: "voice",
    voices: GEMINI_VOICES,
    defaultVoice: "Kore",
    styleField: "style_instructions",
    output: "wav",
    latency: "~5-15s",
  };
}

function elevenlabs(id: string): FalTtsProfile {
  return {
    id,
    family: "elevenlabs",
    textField: "text",
    maxChars: 5000,
    voiceField: "voice",
    defaultVoice: "Rachel",
    formatField: "output_format",
    formats: ELEVENLABS_FORMATS,
    defaultFormat: "mp3_44100_128",
    languageField: "language_code",
    output: "mp3",
    latency: "~3-10s",
  };
}

export const FAL_TTS_PROFILES: readonly FalTtsProfile[] = [
  gemini("google/gemini-3.8-flash-tts"),
  gemini("google/gemini-3.8-flash-lite-tts"),
  elevenlabs("elevenlabs/tts/eleven-v4"),
  elevenlabs("elevenlabs/tts/eleven-v4-turbo"),
];

export function findTtsProfile(model: string): FalTtsProfile | undefined {
  const id = model.trim().replace(/^\/+|\/+$/g, "");
  return FAL_TTS_PROFILES.find((p) => p.id === id);
}

/** Output container for an ElevenLabs `output_format` (codec_rate_bitrate). */
export function outputForFormat(format: string): string {
  const codec = format.split("_")[0] ?? "";
  return codec === "ulaw" || codec === "alaw" ? codec : codec || "bin";
}

export interface TtsFlags {
  text?: string;
  voice?: string;
  style?: string;
  format?: string;
  language?: string;
  /** Text field for an untyped model (default "text"). */
  textField?: string;
  /** Extra model-specific fields from --input. */
  extra?: Record<string, unknown>;
}

export interface TtsInput {
  input: Record<string, unknown>;
  profile?: FalTtsProfile;
  /** Audio container expected from the request, when the profile tells. */
  expectedOutput?: string;
}

const FIELD_RE = /^[A-Za-z_]\w{0,63}$/;
const UNSAFE_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

function pick(list: readonly string[], value: string, what: string, model: string): string {
  const match = list.find((v) => v.toLowerCase() === value.trim().toLowerCase());
  if (!match) {
    throw new ValidationError(`Invalid ${what} "${value}" for ${model}. Valid: ${list.join(", ")}`);
  }
  return match;
}

function unsupported(flag: string, model: string, hint: string): never {
  throw new ValidationError(`${flag} is not supported by ${model}: ${hint}`);
}

/**
 * Build the queue input for `model` from the command flags. Throws
 * ValidationError for anything the endpoint would reject (missing or
 * oversized text, unknown voice or format, a flag it has no field for, a
 * field set twice), so nothing is submitted, or billed, for it.
 */
export function buildTtsInput(model: string, flags: TtsFlags): TtsInput {
  const profile = findTtsProfile(model);
  const extra = { ...(flags.extra ?? {}) };
  const text = flags.text?.trim() ? flags.text : undefined;
  const input: Record<string, unknown> = {};
  const set = (field: string, value: unknown, flag: string) => {
    if (field in extra) {
      throw new ValidationError(`Set ${field} with ${flag} or --input, not both`);
    }
    input[field] = value;
  };

  if (!profile) {
    const field = flags.textField ?? "text";
    if (!FIELD_RE.test(field) || UNSAFE_FIELDS.has(field)) {
      throw new ValidationError(`Invalid --text-field: ${field}`);
    }
    if (!text && !(field in extra)) {
      throw new ValidationError("Provide the text to speak (argument or --text-file)");
    }
    if (text) set(field, text, "the text");
    if (flags.voice) set("voice", flags.voice, "--voice");
    for (const [flag, value] of [
      ["--style", flags.style],
      ["--format", flags.format],
      ["--language", flags.language],
    ] as const) {
      if (value !== undefined) {
        unsupported(flag, model, "it has no typed profile; pass the model's own field in --input");
      }
    }
    return { input: { ...extra, ...input } };
  }

  if (flags.textField !== undefined && flags.textField !== profile.textField) {
    throw new ValidationError(
      `--text-field does not apply to ${profile.id}: it reads the text from "${profile.textField}"`,
    );
  }
  const dialogue = profile.dialogueField !== undefined && profile.dialogueField in extra;
  if (text && dialogue) {
    throw new ValidationError(
      `Omit the text when --input has ${profile.dialogueField}: ${profile.id} speaks either one text or a dialogue`,
    );
  }
  if (text) {
    if (profile.maxChars !== undefined && text.length > profile.maxChars) {
      throw new ValidationError(
        `Text is ${text.length} characters; ${profile.id} accepts at most ${profile.maxChars}`,
      );
    }
    set(profile.textField, text, "the text");
  } else if (!dialogue && !(profile.textField in extra)) {
    throw new ValidationError(
      `Provide the text to speak (argument or --text-file)${
        profile.dialogueField ? `, or ${profile.dialogueField} in --input for dialogue` : ""
      }`,
    );
  }

  if (flags.voice !== undefined) {
    const voice = profile.voices
      ? pick(profile.voices, flags.voice, "voice", profile.id)
      : flags.voice.trim();
    if (!voice) throw new ValidationError("--voice must not be empty");
    set(profile.voiceField, voice, "--voice");
  }

  if (flags.style !== undefined) {
    if (!profile.styleField) {
      unsupported(
        "--style",
        profile.id,
        "direct delivery with audio tags in the text, e.g. [whispering]",
      );
    }
    set(profile.styleField, flags.style, "--style");
  }

  let expectedOutput = profile.output;
  if (flags.format !== undefined) {
    if (!profile.formatField || !profile.formats) {
      unsupported("--format", profile.id, `it always returns ${profile.output.toUpperCase()}`);
    }
    const format = pick(profile.formats, flags.format, "--format", profile.id);
    set(profile.formatField, format, "--format");
    expectedOutput = outputForFormat(format);
  } else if (profile.formatField) {
    const fromInput = extra[profile.formatField];
    if (typeof fromInput === "string") expectedOutput = outputForFormat(fromInput);
  }

  if (flags.language !== undefined) {
    if (!profile.languageField) {
      unsupported("--language", profile.id, "the language follows the text");
    }
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(flags.language)) {
      throw new ValidationError(`Invalid --language "${flags.language}" (expected e.g. en or vi)`);
    }
    set(profile.languageField, flags.language, "--language");
  }

  return { input: { ...extra, ...input }, profile, expectedOutput };
}
