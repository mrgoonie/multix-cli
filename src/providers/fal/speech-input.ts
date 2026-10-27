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
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
function fieldName(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!FIELD_RE.test(value) || RESERVED_FIELDS.has(value)) {
    throw new ValidationError(`${flag} must be a plain input field name, got "${value}"`);
  }
  return value;
}

function verifiedIds(): string {
  return FAL_SPEECH_MODELS.map((m) => m.id).join(", ");
}

function checkText(text: string, profile: FalSpeechModel | undefined): void {
  if (text.trim() === "") throw new ValidationError("The text to speak is blank");
  // Counted in code points, as fal's schema validation does.
  const chars = [...text].length;
  if (profile?.maxTextChars && chars > profile.maxTextChars) {
    throw new ValidationError(
      `${profile.id} accepts at most ${profile.maxTextChars} characters of text, got ${chars}`,
    );
  }
}

function checkFormat(format: string, profile: FalSpeechModel, flag: string): void {
  if (!profile.formats?.includes(format)) {
    throw new ValidationError(
      `Unknown ${flag} "${format}" for ${profile.id}. Formats: ${profile.formats?.join(", ") ?? "none"}`,
    );
  }
}

/** ISO 639 language code with an optional region or script subtag (en, vi, pt-BR). */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function checkLanguage(language: unknown, flag: string): void {
  if (typeof language !== "string" || !LANGUAGE_RE.test(language)) {
    throw new ValidationError(
      `${flag} must be a language code such as en or vi, got ${JSON.stringify(language)}`,
    );
  }
}

/** The voice spelled as the model lists it; throws when the list does not have it. */
function knownVoice(voice: unknown, profile: FalSpeechModel, what: string): string {
  if (typeof voice !== "string" || voice.trim() === "") {
    throw new ValidationError(`${what} must be a non-empty string`);
  }
  if (!profile.voices) return voice;
  const match = profile.voices.find((v) => v.toLowerCase() === voice.trim().toLowerCase());
  if (!match) {
    throw new ValidationError(
      `Unknown voice "${voice}" for ${profile.id}. Voices: ${profile.voices.join(", ")}`,
    );
  }
  return match;
}

function objectList(value: unknown, what: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => v === null || typeof v !== "object" || Array.isArray(v))
  ) {
    throw new ValidationError(`${what} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function nonBlank(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${what} must be a non-empty string`);
  }
  return value;
}

/**
 * A multi-speaker dialogue, per fal's schema (SpeakerConfig, SpeechTurn):
 * exactly two `speakers` with distinct ids and known voices, and at least one
 * turn naming one of them with non-empty text. fal queues (and bills) a
 * malformed dialogue and only fails it at result time, so it is checked here.
 * Returns the speakers with their voices spelled as the model lists them.
 */
function checkDialogue(
  profile: FalSpeechModel,
  turnsValue: unknown,
  speakersValue: unknown,
): Record<string, unknown>[] {
  const field = profile.dialogueField as string;
  const turns = objectList(turnsValue, `--input ${field}`);
  if (turns.length === 0) throw new ValidationError(`--input ${field} must not be empty`);
  if (speakersValue === undefined) {
    throw new ValidationError(`--input ${field} needs "speakers": two {speaker_id, voice} entries`);
  }
  const speakers = objectList(speakersValue, "--input speakers");
  if (speakers.length !== 2) {
    throw new ValidationError(
      `--input speakers must have exactly 2 entries for ${profile.id}, got ${speakers.length}`,
    );
  }
  const ids = new Set<string>();
  const checked = speakers.map((s, i) => {
    const id = nonBlank(s.speaker_id, `speakers[${i}].speaker_id`);
    if (ids.has(id)) throw new ValidationError(`speakers[${i}].speaker_id "${id}" is repeated`);
    ids.add(id);
    return { ...s, voice: knownVoice(s.voice, profile, `speakers[${i}].voice`) };
  });
  turns.forEach((t, i) => {
    const id = nonBlank(t.speaker_id, `${field}[${i}].speaker_id`);
    if (!ids.has(id)) {
      throw new ValidationError(`${field}[${i}].speaker_id "${id}" is not one of the speakers`);
    }
    nonBlank(t.text, `${field}[${i}].text`);
  });
  return checked;
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
  if (voiceField === textField) {
    throw new ValidationError(`--voice-field and --text-field are both "${textField}"`);
  }
  const has = (field: string) => Object.hasOwn(extra, field);

  const input: Record<string, unknown> = { ...extra };
  const set = (flag: string, field: string, value: unknown) => {
    if (has(field)) {
      throw new ValidationError(`${flag} and --input both set "${field}"; use one of them`);
    }
    input[field] = value;
  };

  const dialogue = profile?.dialogueField !== undefined && has(profile.dialogueField);
  if (profile && dialogue) {
    if (flags.text !== undefined || has(textField)) {
      throw new ValidationError(
        `Omit the text when --input has "${profile.dialogueField}": ${profile.id} speaks either one text or a dialogue`,
      );
    }
    if (flags.voice !== undefined || (voiceField && has(voiceField))) {
      throw new ValidationError(
        "--voice does not apply to a dialogue: set each speaker's voice in --input speakers",
      );
    }
    input.speakers = checkDialogue(profile, extra[profile.dialogueField as string], extra.speakers);
  }

  if (flags.text !== undefined) {
    checkText(flags.text, profile);
    set("--text", textField, flags.text);
  } else if (has(textField)) {
    const text = extra[textField];
    if (profile && typeof text !== "string") {
      throw new ValidationError(`--input "${textField}" must be a string`);
    }
    if (typeof text === "string") checkText(text, profile);
  } else if (!dialogue) {
    throw new ValidationError(
      "Provide the text: --text <str>, --text-file <path>, or a positional",
    );
  }

  if (flags.voice !== undefined) {
    if (!voiceField)
      throw new ValidationError(`Pass --voice-field <field> to set a voice on ${flags.model}`);
    set("--voice", voiceField, profile ? knownVoice(flags.voice, profile, "--voice") : flags.voice);
  } else if (profile && voiceField && has(voiceField)) {
    input[voiceField] = knownVoice(extra[voiceField], profile, `--input ${voiceField}`);
  }

  if (flags.style !== undefined) {
    if (!profile?.styleField) throw unsupported("--style", flags.model);
    set("--style", profile.styleField, flags.style);
  }

  if (flags.language !== undefined) {
    if (!profile?.languageField) throw unsupported("--language", flags.model);
    checkLanguage(flags.language, "--language");
    set("--language", profile.languageField, flags.language);
  } else if (profile?.languageField && has(profile.languageField)) {
    checkLanguage(extra[profile.languageField], `--input ${profile.languageField}`);
  }

  let format: string | undefined;
  if (flags.format !== undefined) {
    if (!profile?.formatField || !profile.formats) throw unsupported("--format", flags.model);
    checkFormat(flags.format, profile, "--format");
    set("--format", profile.formatField, flags.format);
    format = flags.format;
  } else if (profile?.formatField && has(profile.formatField)) {
    const extraFormat = extra[profile.formatField];
    if (typeof extraFormat !== "string") {
      throw new ValidationError(`--input "${profile.formatField}" must be a string`);
    }
    checkFormat(extraFormat, profile, `--input ${profile.formatField}`);
    format = extraFormat;
  }

  return { input, ...(profile ? { profile } : {}), ...(format ? { format } : {}) };
}
