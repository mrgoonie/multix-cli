/**
 * What each speech (TTS) model behind `multix speech` accepts: languages,
 * formats, delivery controls, voices, async support and how it bills. The
 * façade validates a request against this table before any provider is
 * called, and `multix speech models` prints it, so an agent learns the
 * differences from one place instead of probing each provider.
 *
 * Model ids come from each provider's own model list, so a model added there
 * shows up here too; per-model facts default to "not documented" (null) until
 * a row below states them with a source. Data only: no `node:*` imports.
 */

import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_MODEL_CAPS,
  type ElevenLabsTtsModel,
} from "../providers/elevenlabs/models.js";
import { FAL_SPEECH_MODELS, type FalSpeechModel } from "../providers/fal/speech-models.js";
import {
  FISH_PUBLIC_VOICES,
  FISH_TTS_FORMATS,
  FISH_TTS_MODELS,
  FISH_TTS_SOURCE,
} from "../providers/fish/models.js";
import { GEMINI_INTERACTIONS_TTS_MODELS, GEMINI_TTS_MODELS } from "../providers/gemini/voices.js";
import { MINIMAX_SPEECH_MODELS } from "../providers/minimax/models.js";

export const SPEECH_PROVIDERS = [
  "gemini",
  "openai",
  "elevenlabs",
  "minimax",
  "atlas",
  "fish",
  "openrouter",
  "fal",
] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

/** Audio containers the façade names; each provider maps them to its own values. */
export const SPEECH_FORMATS = ["mp3", "wav", "pcm", "flac", "opus", "aac"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export interface SpeechModel {
  provider: SpeechProvider;
  model: string;
  /** ISO 639-1 codes the provider documents for this model; null when it publishes no list. */
  languages: readonly string[] | null;
  /** Request field that receives `--language`; absent: the model detects the language from the text. */
  language_param?: string;
  /** Containers the façade can write; null: the model decides (passed through, checked after). */
  formats: readonly SpeechFormat[] | null;
  /** Free-text delivery direction (`--style`). */
  style: boolean;
  /** Named emotions (`--emotion`); absent: no emotion parameter. */
  emotions?: readonly string[];
  /** Longest text one request takes; absent: not documented (the provider checks it). */
  max_chars?: number;
  /** Voice used when none is given, when it differs from the provider's default. */
  default_voice?: string;
  /** Voices in one request: 1, or more for multi-speaker dialogue (`--speaker`). */
  max_speakers: number;
  /** Submit-and-return (`--async`) with a resume command. */
  async: boolean;
  source: string;
  verified_at: string;
}

export interface SpeechProviderInfo {
  provider: SpeechProvider;
  /** Env names that must be set (any one of a row), as `multix check` reads them. */
  keys: readonly string[];
  default_voice: string;
  /** How voices are named: a fixed list of names, or provider-side ids. */
  voice_kind: "names" | "ids";
  /** Command that lists voices live, when the provider has one. */
  voices_command?: string;
  /** Provider-specific options allowed in `--extra <provider>.<key>=<value>`, with their type. */
  extras: Readonly<Record<string, "number" | "string" | "boolean">>;
  /** Any model id is accepted (the provider validates it); rows describe the known ones. */
  any_model: boolean;
  /** What the provider bills, so a fallback can say what changes. */
  billing: string;
}

export const SPEECH_PROVIDER_INFO: Readonly<Record<SpeechProvider, SpeechProviderInfo>> = {
  gemini: {
    provider: "gemini",
    keys: ["GEMINI_API_KEY"],
    default_voice: "Kore",
    voice_kind: "names",
    extras: {},
    any_model: false,
    billing: "audio output tokens (Gemini API pricing per model)",
  },
  openai: {
    provider: "openai",
    keys: ["OPENAI_API_KEY"],
    default_voice: "marin",
    voice_kind: "names",
    extras: {},
    any_model: false,
    billing:
      "per character (tts-1, tts-1-hd) or text-input and audio-output tokens (gpt-4o-mini-tts)",
  },
  elevenlabs: {
    provider: "elevenlabs",
    keys: ["ELEVENLABS_API_KEY"],
    default_voice: "kdmDKE6EkgrWrrykO9Qt",
    voice_kind: "ids",
    voices_command: "multix elevenlabs voices list",
    extras: {
      stability: "number",
      similarity_boost: "number",
      style: "number",
      use_speaker_boost: "boolean",
      seed: "number",
      previous_text: "string",
      next_text: "string",
    },
    any_model: false,
    billing: "characters, as plan credits (flash/turbo models cost less per character)",
  },
  minimax: {
    provider: "minimax",
    keys: ["MINIMAX_API_KEY"],
    default_voice: "English_expressive_narrator",
    voice_kind: "ids",
    extras: { speed: "number" },
    any_model: false,
    billing: "per character (hd models cost more than turbo)",
  },
  atlas: {
    provider: "atlas",
    keys: ["ATLASCLOUD_API_KEY"],
    default_voice: "",
    voice_kind: "ids",
    voices_command: "multix atlas models",
    extras: {},
    any_model: true,
    billing: "per request at the model's Atlas Cloud price",
  },
  fish: {
    provider: "fish",
    keys: ["FISH_API_KEY"],
    // A request without reference_id gets an unspecified voice; default to a documented public one.
    default_voice: FISH_PUBLIC_VOICES.adrian ?? "",
    voice_kind: "ids",
    voices_command: "multix fish voices list",
    extras: {
      temperature: "number",
      top_p: "number",
      speed: "number",
      volume: "number",
      chunk_length: "number",
      normalize: "boolean",
      latency: "string",
    },
    any_model: false,
    billing:
      "UTF-8 bytes of the text (drama-3 $50/M list, $10/M promotion until 2026-11-12 17:00 UTC; S2 family $15/M)",
  },
  openrouter: {
    provider: "openrouter",
    keys: ["OPENROUTER_API_KEY"],
    // Voices belong to each model; the rows below name a default where the model needs one.
    default_voice: "",
    voice_kind: "ids",
    voices_command: "multix openrouter speech-models",
    extras: { speed: "number", zdr: "boolean", deny_data_collection: "boolean" },
    any_model: true,
    billing:
      "the model's OpenRouter price: per input character for most models (Fish Audio per UTF-8 byte), per output second for a few (Seed Audio)",
  },
  fal: {
    provider: "fal",
    keys: ["FAL_KEY"],
    default_voice: "Kore",
    voice_kind: "names",
    voices_command: "multix fal voices",
    extras: {},
    any_model: false,
    billing: "the endpoint's fal.ai price (see https://fal.ai/models/<model>)",
  },
};

const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/speech-generation";
const OPENAI_SOURCE = "https://platform.openai.com/docs/guides/text-to-speech";
const ELEVENLABS_SOURCE = "https://elevenlabs.io/docs/models";
const MINIMAX_SOURCE = "https://platform.minimax.io/docs/api-reference/speech-t2a-http";
const ATLAS_SOURCE = "https://www.atlascloud.ai/models";
/** The live speech model list (models, voices, prices) the OpenRouter rows were checked against. */
const OPENROUTER_SOURCE = "https://openrouter.ai/api/v1/models?output_modalities=speech";
const VERIFIED = "2026-10-26";

const codes = (list: string): readonly string[] => list.split(" ");

/** Gemini 3.8 Flash-Lite TTS: languages listed on the speech-generation page. */
const GEMINI_LITE_LANGUAGES = codes(
  "af ak am hy as bn eu be bs bg yue ca ceb zh hr cs da nl ar en et fil fr gl lg ka de el gu ht mn ha he hi hu is id fa it ja jv ks kk km ki rw kg ko ky lo ln mk ml mt mr ne ff az uz nb nn ny or ps pl pt pa ro ru sr si sk es lv ms ta te tr vi",
);
/** Gemini 3.8 Flash TTS: the Flash-Lite list plus the languages only Flash covers. */
const GEMINI_FLASH_LANGUAGES = [
  ...GEMINI_LITE_LANGUAGES,
  ...codes("ba dz fi gn ig lb lt my oc sd sl so sq ss st sv sw tg th ti ug"),
];
/** Languages of the Whisper training set, which the OpenAI TTS guide points to. */
const OPENAI_LANGUAGES = codes(
  "af ar hy az be bs bg ca zh hr cs da nl en et fi fr gl de el he hi hu is id it ja kn kk ko lv lt mk ms mr mi ne no fa pl pt ro ru sr sk sl es sw sv tl ta th tr uk ur vi cy",
);
const ELEVENLABS_V2_LANGUAGES = codes(
  "en ja zh de hi fr ko pt it es id nl tr fil pl sv bg ro ar cs el fi hr ms sk da ta uk ru",
);
const ELEVENLABS_V25_LANGUAGES = [...ELEVENLABS_V2_LANGUAGES, ...codes("hu no vi")];
const ELEVENLABS_V3_LANGUAGES = codes(
  "af ar hy as ast az be bn bs bg my yue ca ceb ny hr cs da nl en et fil fi fr gl ka de el gu ha he hi hu is id ga it ja jv kn kk ky ko lv ln lt lb mk ms ml mt zh mi mr mn ne no oc or ps fa pl pt pa ro ru sr sd sk sl so es sw sv tg ta te th tr uk ur uz vi cy yo",
);

/** MiniMax `language_boost` value for each language code it documents. */
export const MINIMAX_LANGUAGE_BOOST: Readonly<Record<string, string>> = {
  zh: "Chinese",
  yue: "Chinese,Yue",
  en: "English",
  ar: "Arabic",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  de: "German",
  tr: "Turkish",
  nl: "Dutch",
  uk: "Ukrainian",
  vi: "Vietnamese",
  id: "Indonesian",
  ja: "Japanese",
  it: "Italian",
  ko: "Korean",
  th: "Thai",
  pl: "Polish",
  ro: "Romanian",
  el: "Greek",
  cs: "Czech",
  fi: "Finnish",
  hi: "Hindi",
  bg: "Bulgarian",
  da: "Danish",
  he: "Hebrew",
  ms: "Malay",
  fa: "Persian",
  sk: "Slovak",
  sv: "Swedish",
  hr: "Croatian",
  fil: "Filipino",
  hu: "Hungarian",
  no: "Norwegian",
  sl: "Slovenian",
  ca: "Catalan",
  nn: "Nynorsk",
  ta: "Tamil",
  af: "Afrikaans",
};
/** Languages the speech-02 models do not take (added in speech-2.6). */
const MINIMAX_LATE_LANGUAGES = new Set(["fa", "fil", "ta"]);
const MINIMAX_EMOTIONS = codes("happy sad angry fearful disgusted surprised calm");
/** speech-2.6 adds two delivery modes to the emotion list. */
const MINIMAX_26_EMOTIONS = [...MINIMAX_EMOTIONS, "fluent", "whisper"];

const ATLAS_XAI_LANGUAGES = codes("en zh ar bn fr de hi id it ja ko pt ru es tr vi");

function geminiModel(model: string): SpeechModel {
  return {
    provider: "gemini",
    model,
    // Legacy previews (shut down 2026-11-17) publish no per-model list.
    languages:
      model === "gemini-3.8-flash-tts"
        ? GEMINI_FLASH_LANGUAGES
        : model === "gemini-3.8-flash-lite-tts"
          ? GEMINI_LITE_LANGUAGES
          : null,
    formats: ["wav", "pcm"],
    style: GEMINI_INTERACTIONS_TTS_MODELS.has(model),
    max_speakers: 2,
    async: false,
    source: GEMINI_SOURCE,
    verified_at: VERIFIED,
  };
}

const OPENAI_MODELS: readonly SpeechModel[] = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"].map(
  (model) => ({
    provider: "openai",
    model,
    languages: OPENAI_LANGUAGES,
    formats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
    style: model === "gpt-4o-mini-tts",
    max_chars: 4096,
    // tts-1 and tts-1-hd take only the nine original voices.
    ...(model === "gpt-4o-mini-tts" ? {} : { default_voice: "alloy" }),
    max_speakers: 1,
    async: false,
    source: OPENAI_SOURCE,
    verified_at: VERIFIED,
  }),
);

function elevenLabsModel(model: ElevenLabsTtsModel): SpeechModel {
  const caps = ELEVENLABS_TTS_MODEL_CAPS[model];
  // v4 publishes no per-model list; the API answers an unsupported code with 400.
  const languages = model.startsWith("eleven_v3")
    ? ELEVENLABS_V3_LANGUAGES
    : model === "eleven_multilingual_v2"
      ? ELEVENLABS_V2_LANGUAGES
      : model.endsWith("_v2_5")
        ? ELEVENLABS_V25_LANGUAGES
        : model === "eleven_flash_v2" || model === "eleven_turbo_v2"
          ? ["en"]
          : null;
  const languageParam = caps.languageCode;
  const maxChars = caps.maxChars;
  return {
    provider: "elevenlabs",
    model,
    languages,
    ...(languageParam ? { language_param: "language_code" } : {}),
    max_chars: maxChars,
    formats: ["mp3", "pcm"],
    style: false,
    max_speakers: 1,
    async: false,
    source: ELEVENLABS_SOURCE,
    verified_at: VERIFIED,
  };
}

function minimaxModel(model: string): SpeechModel {
  return {
    provider: "minimax",
    model,
    languages: Object.keys(MINIMAX_LANGUAGE_BOOST).filter(
      (code) => !(model.startsWith("speech-02") && MINIMAX_LATE_LANGUAGES.has(code)),
    ),
    language_param: "language_boost",
    // The generator sends at most 10,000 characters; longer text would be cut and still billed.
    max_chars: 10_000,
    formats: ["mp3", "wav", "flac", "pcm"],
    style: false,
    emotions: model.startsWith("speech-2.6") ? MINIMAX_26_EMOTIONS : MINIMAX_EMOTIONS,
    max_speakers: 1,
    async: false,
    source: MINIMAX_SOURCE,
    verified_at: VERIFIED,
  };
}

const ATLAS_MODELS: readonly SpeechModel[] = [
  {
    provider: "atlas",
    model: "xai/tts-v1",
    languages: ATLAS_XAI_LANGUAGES,
    language_param: "language",
    formats: ["mp3", "wav", "pcm"],
    style: false,
    max_speakers: 1,
    async: true,
    source: ATLAS_SOURCE,
    verified_at: VERIFIED,
  },
];

/**
 * Fish Audio publishes no per-model language list; `language` only steers
 * text normalization. Multi-speaker dialogue goes through `multix fish tts
 * --turns-file`, so the façade sends one voice.
 */
const FISH_MODELS: readonly SpeechModel[] = FISH_TTS_MODELS.map((model) => ({
  provider: "fish",
  model,
  languages: null,
  language_param: "language",
  formats: [...FISH_TTS_FORMATS],
  style: false,
  max_speakers: 1,
  async: false,
  source: FISH_TTS_SOURCE,
  verified_at: "2026-10-27",
}));

/**
 * OpenRouter serves many speech models and adds new ones often, so any model
 * id is accepted: before the paid request the adapter checks the model and
 * voice against the live list (`multix openrouter speech-models`). These rows
 * describe the documented families. OpenRouter takes no language parameter,
 * and multi-speaker turns go through `multix openrouter tts --turns-file`.
 */
const OPENROUTER_MODELS: readonly SpeechModel[] = [
  ...["google/gemini-3.8-flash-tts", "google/gemini-3.8-flash-lite-tts"].map((model) => ({
    model,
    // Gemini returns pcm only; wav is that pcm with a WAV header.
    formats: ["wav", "pcm"] as const,
    style: true,
    default_voice: "Kore",
  })),
  ...["elevenlabs/eleven-v4", "elevenlabs/eleven-v4-turbo"].map((model) => ({
    model,
    formats: ["mp3", "wav", "pcm"] as const,
    style: false,
    default_voice: "sarah",
  })),
  { model: "fish-audio/drama-3", formats: ["mp3", "wav", "pcm"] as const, style: true },
].map((row) => ({
  provider: "openrouter",
  languages: null,
  max_speakers: 1,
  async: false,
  source: OPENROUTER_SOURCE,
  verified_at: "2026-10-27",
  ...row,
}));

/**
 * fal.ai endpoints with a verified input schema (fal's OpenAPI per endpoint).
 * fal writes wav for Gemini and the requested container for ElevenLabs;
 * `--async` submits and returns the queue receipt. Dialogue turns go through
 * `multix fal tts --input`, so the façade sends one voice.
 */
function falModel(m: FalSpeechModel): SpeechModel {
  return {
    provider: "fal",
    model: m.id,
    languages: null,
    ...(m.languageField ? { language_param: m.languageField } : {}),
    formats: m.formatField ? ["mp3", "pcm"] : [m.output as SpeechFormat],
    style: Boolean(m.styleField),
    ...(m.maxTextChars ? { max_chars: m.maxTextChars } : {}),
    default_voice: m.defaultVoice,
    max_speakers: 1,
    async: true,
    source: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${m.id}`,
    verified_at: "2026-10-27",
  };
}

/** Every model the façade knows, in provider order. */
export function speechModels(): SpeechModel[] {
  return [
    ...[...GEMINI_TTS_MODELS].map(geminiModel),
    ...OPENAI_MODELS,
    ...ELEVENLABS_TTS_MODELS.map(elevenLabsModel),
    ...[...MINIMAX_SPEECH_MODELS].map(minimaxModel),
    ...ATLAS_MODELS,
    ...FISH_MODELS,
    ...OPENROUTER_MODELS,
    ...FAL_SPEECH_MODELS.map(falModel),
  ];
}

/**
 * Capabilities of `model` on `provider`. A provider that takes any model id
 * (Atlas Cloud, OpenRouter) gets a row with nothing documented: language and
 * format are then checked by the provider, not here.
 */
export function findSpeechModel(provider: SpeechProvider, model: string): SpeechModel | undefined {
  const rows = speechModels().filter((m) => m.provider === provider);
  const known = rows.find((m) => m.model === model);
  if (known) return known;
  // A dated snapshot (gpt-4o-mini-tts-2025-12-15) has its family's capabilities.
  const family = rows
    .filter((m) => model.startsWith(`${m.model}-`))
    .sort((a, b) => b.model.length - a.model.length)[0];
  if (family) return { ...family, model };
  if (!SPEECH_PROVIDER_INFO[provider].any_model) return undefined;
  return {
    provider,
    model,
    languages: null,
    formats: null,
    style: false,
    max_speakers: 1,
    async: provider === "atlas",
    source: provider === "openrouter" ? OPENROUTER_SOURCE : ATLAS_SOURCE,
    verified_at: VERIFIED,
  };
}

export function isSpeechProvider(value: string): value is SpeechProvider {
  return (SPEECH_PROVIDERS as readonly string[]).includes(value);
}

export function isSpeechFormat(value: string): value is SpeechFormat {
  return (SPEECH_FORMATS as readonly string[]).includes(value);
}
