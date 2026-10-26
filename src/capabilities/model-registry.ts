/**
 * Models verified to run through a multix command, with the inputs their
 * provider schema accepts. Only ids checked against the provider's own schema
 * belong here; everything else a catalog lists stays "unverified" in discovery.
 *
 * `command` is the multix command to use: `fal tts` maps typed flags onto the
 * ids it lists; other verified fal ids run through `fal run --input`.
 *
 * fal entries: fields from https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>.
 * Re-check them (and bump verified_at) when an endpoint changes or disappears
 * from `multix models --task speech --live`.
 */

import {
  ELEVENLABS_FORMATS as ELEVEN_FORMATS,
  GEMINI_VOICES as GEMINI_TTS_VOICES,
} from "../providers/fal/speech-models.js";
import type { InputSpec, ModelCapability, Task } from "./capability-types.js";

const falSchema = (id: string) => `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${id}`;
const VERIFIED = "2026-10-26";

const MINIMAX_LANGUAGES = [
  "Chinese",
  "Chinese,Yue",
  "English",
  "Arabic",
  "Russian",
  "Spanish",
  "French",
  "Portuguese",
  "German",
  "Turkish",
  "Dutch",
  "Ukrainian",
  "Vietnamese",
  "Indonesian",
  "Japanese",
  "Italian",
  "Korean",
  "Thai",
  "Polish",
  "Romanian",
  "Greek",
  "Czech",
  "Finnish",
  "Hindi",
  "Bulgarian",
  "Danish",
  "Hebrew",
  "Malay",
  "Slovak",
  "Swedish",
  "Croatian",
  "Hungarian",
  "Norwegian",
  "Slovenian",
  "Catalan",
  "Nynorsk",
  "Afrikaans",
  "auto",
] as const;

function elevenV4(model: string, name: string): ModelCapability {
  return {
    provider: "fal",
    model,
    name,
    tasks: ["speech"],
    command: "fal tts",
    example: `multix fal tts "Hello from multix" --model ${model} --voice Rachel`,
    inputs: {
      text: {
        type: "string",
        required: true,
        max_length: 5000,
        note: "audio tags like [whispering]",
      },
      voice: { type: "string", default: "Rachel", note: "ElevenLabs voice name or id" },
      stability: { type: "number", default: 0.5 },
      similarity_boost: { type: "number", default: 0.75 },
      seed: { type: "integer" },
      language_code: { type: "string", note: "ISO 639-1" },
      apply_text_normalization: { type: "string", values: ["auto", "on", "off"], default: "auto" },
      output_format: { type: "string", values: ELEVEN_FORMATS, default: "mp3_44100_128" },
      timestamps: { type: "boolean", default: false },
    },
    outputs: [
      { field: "audio", modality: "audio", formats: ["mp3", "pcm", "ulaw", "alaw", "opus"] },
    ],
    voices: {
      examples: ["Rachel", "Aria", "Roger", "Sarah", "George"],
      note: "any ElevenLabs voice name or id",
    },
    languages: "auto",
    async: true,
    limits: { max_chars: 5000 },
    source: { url: falSchema(model), verified_at: VERIFIED },
  };
}

function geminiTts(model: string, name: string): ModelCapability {
  const inputs: Record<string, InputSpec> = {
    prompt: { type: "string", note: "verbatim text for one speaker" },
    voice: { type: "string", values: GEMINI_TTS_VOICES, default: "Kore" },
    style_instructions: { type: "string", note: "delivery style, not spoken" },
    speakers: { type: "array", note: "exactly two {alias, voice} for dialogue" },
    turns: { type: "array", note: "dialogue turns naming a speaker alias" },
    enable_safety_checker: { type: "boolean", default: true },
  };
  return {
    provider: "fal",
    model,
    name,
    tasks: ["speech"],
    command: "fal tts",
    example: `multix fal tts "Have a wonderful day!" --model ${model} --voice Kore`,
    inputs,
    required_any: [["prompt"], ["speakers", "turns"]],
    outputs: [{ field: "audio", modality: "audio", formats: ["wav"] }],
    voices: GEMINI_TTS_VOICES,
    languages: "auto",
    async: true,
    limits: { max_input_tokens: 8192 },
    source: { url: falSchema(model), verified_at: VERIFIED },
  };
}

export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  elevenV4("elevenlabs/tts/eleven-v4", "Eleven v4 (fal)"),
  elevenV4("elevenlabs/tts/eleven-v4-turbo", "Eleven v4 Turbo (fal)"),
  geminiTts("google/gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS (fal)"),
  geminiTts("google/gemini-3.8-flash-lite-tts", "Gemini 3.8 Flash Lite TTS (fal)"),
  {
    provider: "fal",
    model: "fal-ai/minimax/speech-2.8-hd",
    name: "MiniMax Speech 2.8 HD (fal)",
    tasks: ["speech"],
    command: "fal run",
    example:
      'multix fal run fal-ai/minimax/speech-2.8-hd --input \'{"prompt":"Hello from multix","voice_setting":{"voice_id":"Wise_Woman"}}\'',
    inputs: {
      prompt: { type: "string", required: true, max_length: 10000 },
      voice_setting: {
        type: "object",
        note: "{voice_id, speed, vol, pitch, english_normalization}; voice_id default Wise_Woman",
      },
      audio_setting: {
        type: "object",
        note: "{format: mp3|pcm|flac, sample_rate, bitrate, channel}",
      },
      language_boost: { type: "string", values: MINIMAX_LANGUAGES },
      output_format: { type: "string", values: ["url", "hex"], default: "hex" },
      voice_modify: { type: "object" },
      pronunciation_dict: { type: "object" },
      normalization_setting: { type: "object" },
      enable_safety_checker: { type: "boolean", default: true },
    },
    outputs: [{ field: "audio", modality: "audio", formats: ["mp3", "pcm", "flac"] }],
    voices: {
      examples: ["Wise_Woman", "Friendly_Person", "Deep_Voice_Man", "Calm_Woman", "Casual_Guy"],
      note: "MiniMax system or cloned voice id in voice_setting.voice_id",
    },
    languages: MINIMAX_LANGUAGES.filter((l) => l !== "auto"),
    async: true,
    limits: { max_chars: 10000 },
    source: { url: falSchema("fal-ai/minimax/speech-2.8-hd"), verified_at: VERIFIED },
  },
];

export function findModelCapability(model: string, provider?: string): ModelCapability | undefined {
  return MODEL_CAPABILITIES.find(
    (m) => m.model === model && (!provider || m.provider === provider),
  );
}

export function verifiedModels(filter: { task?: Task; provider?: string } = {}): ModelCapability[] {
  return MODEL_CAPABILITIES.filter(
    (m) =>
      (!filter.task || m.tasks.includes(filter.task)) &&
      (!filter.provider || m.provider === filter.provider),
  );
}

export interface InputCheck {
  /** Fields the endpoint does not accept (typos or another model's options). */
  unsupported: string[];
  /** Required fields that are missing. */
  missing: string[];
  /** Fields whose value is outside the provider's listed values. */
  invalid: { field: string; value: unknown; allowed: readonly (string | number)[] }[];
}

/** Compare an input object with a verified model's schema; never throws. */
export function checkModelInput(cap: ModelCapability, input: Record<string, unknown>): InputCheck {
  const unsupported = Object.keys(input).filter((k) => !(k in cap.inputs));
  const missing = Object.entries(cap.inputs)
    .filter(([name, spec]) => spec.required && input[name] === undefined)
    .map(([name]) => name);
  if (cap.required_any && !cap.required_any.some((g) => g.every((f) => input[f] !== undefined))) {
    missing.push(cap.required_any.map((g) => g.join("+")).join(" or "));
  }
  const invalid = Object.entries(cap.inputs)
    .filter(([name, spec]) => {
      const value = input[name];
      return (
        spec.values !== undefined &&
        value !== undefined &&
        value !== null &&
        !spec.values.includes(value as string | number)
      );
    })
    .map(([name, spec]) => ({ field: name, value: input[name], allowed: spec.values ?? [] }));
  return { unsupported, missing, invalid };
}
