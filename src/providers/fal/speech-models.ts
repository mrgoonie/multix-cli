/**
 * fal.ai text-to-speech endpoints whose input and output schemas were checked
 * against fal's live OpenAPI (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>).
 * Their field names differ (Gemini speaks `prompt`, ElevenLabs `text`), so
 * `multix fal tts` maps its flags per model and never assumes one shape.
 * Any other fal TTS id runs with an explicit `--text-field`.
 * Runtime-neutral: no `node:*` imports; the live catalog lookup takes `fetch`.
 */

import { ProviderError } from "../../core/errors.js";

export interface FalSpeechModel {
  id: string;
  label: string;
  /** Input field that carries the text to speak. */
  textField: string;
  /** Character limit fal enforces on the text field, when it has one. */
  maxTextChars?: number;
  voiceField: string;
  defaultVoice: string;
  /** Closed voice list (validated); absent when the model takes any voice name or id. */
  voices?: readonly string[];
  /** Example voices for an open voice field. */
  exampleVoices?: readonly string[];
  /** Multi-speaker input that replaces the text field (set through --input). */
  dialogueField?: string;
  /** Field for free-text delivery directions, when the model has one. */
  styleField?: string;
  languageField?: string;
  formatField?: string;
  formats?: readonly string[];
  defaultFormat?: string;
  /** Container the endpoint returns when the model has no format choice. */
  output: string;
  latency: "standard" | "low";
}

export const GEMINI_VOICES = [
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

export const ELEVENLABS_FORMATS = [
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

const ELEVENLABS_EXAMPLE_VOICES = ["Rachel", "Aria", "Roger", "Sarah", "George", "Charlotte"];

function gemini(id: string, label: string, latency: FalSpeechModel["latency"]): FalSpeechModel {
  return {
    id,
    label,
    textField: "prompt",
    voiceField: "voice",
    defaultVoice: "Kore",
    voices: GEMINI_VOICES,
    dialogueField: "turns",
    styleField: "style_instructions",
    output: "wav",
    latency,
  };
}

function elevenlabs(id: string, label: string, latency: FalSpeechModel["latency"]): FalSpeechModel {
  return {
    id,
    label,
    textField: "text",
    maxTextChars: 5000,
    voiceField: "voice",
    defaultVoice: "Rachel",
    exampleVoices: ELEVENLABS_EXAMPLE_VOICES,
    languageField: "language_code",
    formatField: "output_format",
    formats: ELEVENLABS_FORMATS,
    defaultFormat: "mp3_44100_128",
    output: "mp3",
    latency,
  };
}

export const FAL_SPEECH_MODELS: readonly FalSpeechModel[] = [
  gemini("google/gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS", "standard"),
  gemini("google/gemini-3.8-flash-lite-tts", "Gemini 3.8 Flash-Lite TTS", "low"),
  elevenlabs("elevenlabs/tts/eleven-v4", "ElevenLabs Eleven v4", "standard"),
  elevenlabs("elevenlabs/tts/eleven-v4-turbo", "ElevenLabs Eleven v4 Turbo", "low"),
];

export function findSpeechModel(id: string): FalSpeechModel | undefined {
  const clean = id.replace(/^\/+|\/+$/g, "");
  return FAL_SPEECH_MODELS.find((m) => m.id === clean);
}

/**
 * Extension for a format value: the codec prefix of `codec_rate_bitrate`
 * (opus comes in an Ogg container), or the model's fixed output.
 */
export function expectedAudioExt(model: FalSpeechModel | undefined, format?: string): string {
  const codec = (format ?? model?.defaultFormat ?? "").split("_")[0];
  if (codec === "opus") return "ogg";
  if (codec) return codec;
  return model?.output ?? "bin";
}

/** One entry of fal's public model catalog. */
export interface FalCatalogModel {
  endpoint_id: string;
  display_name?: string;
  category?: string;
  status?: string;
}

export const FAL_CATALOG_URL = "https://api.fal.ai/v1/models";

/**
 * fal's current text-to-speech endpoints from its public model catalog (no key
 * is sent). Follows the cursor for at most `maxPages` pages.
 */
export async function listFalSpeechCatalog(
  fetchFn: typeof fetch,
  opts: { baseUrl?: string; maxPages?: number; timeoutMs?: number } = {},
): Promise<FalCatalogModel[]> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  // Catalog text is printed to a terminal: drop control characters (escape sequences).
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\p{Cc}/gu, "") : undefined);
  const out: FalCatalogModel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 5); page++) {
    const url = new URL(opts.baseUrl ?? FAL_CATALOG_URL);
    url.searchParams.set("category", "text-to-speech");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchFn(url.toString(), {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) throw new ProviderError(`fal model catalog returned HTTP ${res.status}`, "fal");
    const body = (await res.json()) as {
      models?: Array<{ endpoint_id?: unknown; metadata?: Record<string, unknown> }>;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const m of body.models ?? []) {
      const id = clean(m.endpoint_id);
      if (!id) continue;
      const meta = m.metadata ?? {};
      const displayName = clean(meta.display_name);
      const category = clean(meta.category);
      const status = clean(meta.status);
      out.push({
        endpoint_id: id,
        ...(displayName ? { display_name: displayName } : {}),
        ...(category ? { category } : {}),
        ...(status ? { status } : {}),
      });
    }
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}
