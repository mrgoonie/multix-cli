/**
 * Builds the fal input for `multix fal tts` from typed flags, per model: the
 * text, voice, style, format and language flags land in the fields that
 * model's schema uses, and are refused when it has no such field. Anything
 * else model-specific comes through `--input`. Pure, so it is unit-testable
 * and dry-run safe.
 */

import { ValidationError } from "../../core/errors.js";
import { FAL_SPEECH_MODELS, type FalSpeechModel, findSpeechModel } from "./speech-models.js";

export interface SpeechFlags {
  model: string;
  text?: string;
  voice?: string;
  style?: string;
  format?: string;
  language?: string;
  /** Field overrides; required for models outside the verified list. */
  textField?: string;
  voiceField?: string;
  /** Extra model-specific input (from `--input`). */
  extra?: Record<string, unknown>;
}

export interface SpeechRequest {
  input: Record<string, unknown>;
  /** The verified model profile, when the model is one. */
  profile?: FalSpeechModel;
  /** Output extension implied by the request (e.g. pcm for pcm_16000), when known. */
  format?: string;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fieldName(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!FIELD_RE.test(value)) {
    throw new ValidationError(`${flag} must be a plain input field name, got "${value}"`);
  }
  return value;
}

function verifiedIds(): string {
  return FAL_SPEECH_MODELS.map((m) => m.id).join(", ");
}

function unsupported(flag: string, model: string): ValidationError {
  return new ValidationError(
    `${flag} is not an input of ${model}; pass model-specific fields with --input (see multix fal voices ${model})`,
  );
}

export function buildSpeechRequest(flags: SpeechFlags): SpeechRequest {
  const profile = findSpeechModel(flags.model);
  const extra = flags.extra ?? {};
  const textField = fieldName("--text-field", flags.textField) ?? profile?.textField;
  if (!textField) {
    throw new ValidationError(
      `fal tts has a verified schema for ${verifiedIds()}. For ${flags.model}, pass --text-field <field> (and --voice-field for --voice) from its API schema at https://fal.ai/models/${flags.model}/api`,
    );
  }
  const voiceField = fieldName("--voice-field", flags.voiceField) ?? profile?.voiceField;

  const input: Record<string, unknown> = { ...extra };
  const set = (flag: string, field: string, value: unknown) => {
    if (field in extra) {
      throw new ValidationError(`${flag} and --input both set "${field}"; use one of them`);
    }
    input[field] = value;
  };

  if (flags.text !== undefined) {
    if (flags.text.trim() === "") throw new ValidationError("The text to speak is blank");
    // Counted in code points, as fal's schema validation does.
    const chars = [...flags.text].length;
    if (profile?.maxTextChars && chars > profile.maxTextChars) {
      throw new ValidationError(
        `${profile.id} accepts at most ${profile.maxTextChars} characters of text, got ${chars}`,
      );
    }
    set("--text", textField, flags.text);
  } else if (!(textField in extra) && !(profile?.dialogueField && profile.dialogueField in extra)) {
    throw new ValidationError(
      "Provide the text: --text <str>, --text-file <path>, or a positional",
    );
  }

  if (flags.voice !== undefined) {
    if (!voiceField)
      throw new ValidationError(`Pass --voice-field <field> to set a voice on ${flags.model}`);
    let voice = flags.voice;
    if (profile?.voices) {
      const match = profile.voices.find((v) => v.toLowerCase() === voice.toLowerCase());
      if (!match) {
        throw new ValidationError(
          `Unknown voice "${voice}" for ${profile.id}. Voices: ${profile.voices.join(", ")}`,
        );
      }
      voice = match;
    }
    set("--voice", voiceField, voice);
  }

  if (flags.style !== undefined) {
    if (!profile?.styleField) throw unsupported("--style", flags.model);
    set("--style", profile.styleField, flags.style);
  }

  if (flags.language !== undefined) {
    if (!profile?.languageField) throw unsupported("--language", flags.model);
    set("--language", profile.languageField, flags.language);
  }

  let format: string | undefined;
  if (flags.format !== undefined) {
    if (!profile?.formatField || !profile.formats) throw unsupported("--format", flags.model);
    if (!profile.formats.includes(flags.format)) {
      throw new ValidationError(
        `Unknown --format "${flags.format}" for ${profile.id}. Formats: ${profile.formats.join(", ")}`,
      );
    }
    set("--format", profile.formatField, flags.format);
    format = flags.format;
  } else if (profile?.formatField && typeof extra[profile.formatField] === "string") {
    format = extra[profile.formatField] as string;
  }

  return { input, ...(profile ? { profile } : {}), ...(format ? { format } : {}) };
}
