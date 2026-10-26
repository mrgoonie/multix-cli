/**
 * multix openrouter tts — text-to-speech through OpenRouter's speech endpoint
 * (POST /api/v1/audio/speech). Any speech model OpenRouter lists works:
 * Gemini 3.8 Flash / Flash-Lite TTS, Fish Audio Drama 3, ElevenLabs v4 /
 * v4 Turbo, MiniMax, Voxtral, ...
 *
 * Before the paid request the model and voice are checked against the live
 * catalog (`?output_modalities=speech`), so a typo fails with the valid
 * choices instead of OpenRouter's bare "Provider returned 400". The request is
 * sent once; the cost is then read from /generation (it lags a few seconds).
 * Text is never logged, only its length.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { envDefault } from "../../../core/env-default.js";
import { HttpError, ValidationError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { requireOpenRouterKey } from "../client.js";
import { buildOpenRouterHeaders } from "../payload.js";
import {
  DEFAULT_PCM_SAMPLE_RATE,
  type ResolvedSpeechFormat,
  SPEECH_FORMATS,
  looksLikeMp3,
  parseSpeechFormat,
  pcmDurationSeconds,
  pcmToWav,
  requestFormat,
  resolveSpeechFormat,
} from "../speech-audio.js";
import {
  DEFAULT_OPENROUTER_TTS_MODEL,
  type GenerationStats,
  type SpeechModel,
  type SpeechRequestBody,
  type SpeechTurn,
  createSpeech,
  findSpeechModel,
  getGeneration,
  listSpeechModels,
  matchVoice,
} from "../speech-client.js";

export const OPENROUTER_TTS_MODEL_ENV = "OPENROUTER_TTS_MODEL";
/** Upper bound on input text; OpenRouter models cap far lower (ElevenLabs v4: 10,000). */
const MAX_TEXT_CHARS = 100_000;
const MAX_TURNS = 100;

interface TtsOptions {
  text?: string;
  prompt?: string;
  textFile?: string;
  turnsFile?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  format: string;
  sampleRate?: string;
  speed?: string;
  providerOptions?: string;
  zdr?: boolean;
  denyDataCollection?: boolean;
  modelCheck: boolean;
  cost: boolean;
  costWait: string;
  output?: string;
  verbose?: boolean;
}

function readUtf8(file: string, flag: string): string {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`${flag} file not found: ${file}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

function positiveNumber(value: string, flag: string, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new ValidationError(`${flag} must be a number greater than 0 and at most ${max}`);
  }
  return n;
}

/** Turns from a JSON file: `[{"text": "...", "voice": "Kore", "instructions": "..."}]`. */
export function parseTurns(raw: string): SpeechTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("--turns-file must be a JSON array of {text, voice?, instructions?}");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_TURNS) {
    throw new ValidationError(`--turns-file must be a JSON array of 1 to ${MAX_TURNS} turns`);
  }
  return parsed.map((item, i) => {
    const t = item as Record<string, unknown> | null;
    if (!t || typeof t.text !== "string" || t.text.trim() === "") {
      throw new ValidationError(`--turns-file turn ${i + 1} needs a non-empty "text" string`);
    }
    const turn: SpeechTurn = { text: t.text };
    for (const key of ["voice", "instructions"] as const) {
      const v = t[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || v.trim() === "") {
        throw new ValidationError(
          `--turns-file turn ${i + 1}: "${key}" must be a non-empty string`,
        );
      }
      turn[key] = v;
    }
    return turn;
  });
}

function parseProviderOptions(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      '--provider-options must be a JSON object keyed by provider slug, e.g. {"google-ai-studio":{"temperature":0.7}}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("--provider-options must be a JSON object keyed by provider slug");
  }
  return parsed as Record<string, unknown>;
}

function inputText(opts: TtsOptions): string | SpeechTurn[] {
  const sources = [opts.text ?? opts.prompt, opts.textFile, opts.turnsFile].filter(
    (v) => v !== undefined,
  );
  if (sources.length === 0) {
    throw new ValidationError("Provide the text with --text, --text-file or --turns-file");
  }
  if (sources.length > 1) {
    throw new ValidationError("--text, --text-file and --turns-file cannot be combined");
  }
  if (opts.turnsFile) return parseTurns(readUtf8(opts.turnsFile, "--turns-file"));
  const text = opts.textFile ? readUtf8(opts.textFile, "--text-file") : (opts.text ?? opts.prompt);
  if (!text || text.trim() === "") throw new ValidationError("The text to speak is empty");
  return text;
}

function charCount(input: string | SpeechTurn[]): number {
  return typeof input === "string" ? input.length : input.reduce((n, t) => n + t.text.length, 0);
}

/** Families whose OpenRouter adapter rejects a request without a voice ("An explicit voice is required"). */
const VOICE_REQUIRED = /^(google|elevenlabs)\//;

function voiceList(model: SpeechModel): string {
  const shown = model.voices.slice(0, 12).join(", ");
  const more = model.voices.length > 12 ? `, ... (${model.voices.length} total)` : "";
  return `Voices: ${shown}${more}. List them with: multix openrouter speech-models --model ${model.id}`;
}

function voiceError(model: SpeechModel, voice: string): ValidationError {
  return new ValidationError(`Voice "${voice}" is not offered by ${model.id}. ${voiceList(model)}`);
}

/** Check the model and voices against the live catalog; returns the catalog entry and voice spellings. */
async function checkCatalog(
  model: string,
  voice: string | undefined,
  input: string | SpeechTurn[],
  logger: Logger,
): Promise<{ entry: SpeechModel; voice?: string; input: string | SpeechTurn[] }> {
  const models = await listSpeechModels();
  const entry = findSpeechModel(models, model);
  if (!entry) {
    throw new ValidationError(
      `Model ${model} is not an OpenRouter speech model (model not found in ?output_modalities=speech). List them with: multix openrouter speech-models (or pass --no-model-check for a model OpenRouter does not list yet)`,
    );
  }
  const fix = (v: string) => {
    const matched = matchVoice(entry, v);
    if (!matched) throw voiceError(entry, v);
    return matched;
  };
  const turnsVoiced = Array.isArray(input) && input.every((t) => t.voice);
  if (!voice && !turnsVoiced && VOICE_REQUIRED.test(entry.id) && entry.voices.length > 0) {
    throw new ValidationError(`${entry.id} needs --voice. ${voiceList(entry)}`);
  }
  const resolvedVoice = voice ? fix(voice) : undefined;
  const resolvedInput = Array.isArray(input)
    ? input.map((t) => (t.voice ? { ...t, voice: fix(t.voice) } : t))
    : input;
  logger.debug(`catalog: ${entry.id}, ${entry.voices.length} voice(s)`);
  return {
    entry,
    ...(resolvedVoice ? { voice: resolvedVoice } : {}),
    input: resolvedInput,
  };
}

/** Catalog price x characters, for per-character models only (per-second ones are priced on output). */
function estimateCost(entry: SpeechModel | undefined, chars: number): number | null {
  const perChar = Number(entry?.pricing.prompt);
  const perSecond = Number(entry?.pricing.completion);
  if (!entry || !Number.isFinite(perChar) || perChar <= 0) return null;
  if (Number.isFinite(perSecond) && perSecond > 0) return null;
  return Math.round(perChar * chars * 1e6) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll /generation until it has the stats or `waitMs` passed; undefined when it never answered. */
async function waitForGeneration(
  id: string,
  headers: Record<string, string>,
  waitMs: number,
  logger: Logger,
): Promise<GenerationStats | undefined> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const stats = await getGeneration({ id, headers });
      if (stats) return stats;
    } catch (err) {
      // The audio is already saved; a failed lookup only leaves the cost unknown.
      logger.debug(`generation lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!(err instanceof HttpError) || err.status !== 0) return undefined;
    }
    const delay = Math.min(1000 * 2 ** attempt, 4000);
    if (Date.now() + delay > deadline) return undefined;
    await sleep(delay);
  }
}

function writeAudio(bytes: Uint8Array, ext: string, output: string | undefined): string {
  const dest = path.join(getOutputDir(), `openrouter_tts_${outputStamp()}.${ext}`);
  fs.writeFileSync(dest, bytes);
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dest, target);
  }
  return dest;
}

export function registerOpenRouterTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description(
      "Text-to-speech via OpenRouter /audio/speech (Gemini 3.8 Flash TTS, Fish Audio Drama 3, ElevenLabs v4, ...)",
    )
    .option("--text <str>", "Text to speak")
    .option("--prompt <str>", "Alias for --text")
    .option("--text-file <path>", "Read the text to speak from a UTF-8 file")
    .option(
      "--turns-file <path>",
      'Multi-speaker input: JSON array of {"text", "voice"?, "instructions"?} (Gemini TTS, Fish Audio)',
    )
    .option(
      "--model <id>",
      `Speech model (env ${OPENROUTER_TTS_MODEL_ENV}), e.g. google/gemini-3.8-flash-lite-tts, fish-audio/drama-3, elevenlabs/eleven-v4, elevenlabs/eleven-v4-turbo`,
      envDefault(OPENROUTER_TTS_MODEL_ENV, DEFAULT_OPENROUTER_TTS_MODEL),
    )
    .option(
      "--voice <id>",
      "Voice id of the model (Gemini: Kore, Puck, ...; ElevenLabs: sarah, george, ...)",
    )
    .option(
      "--instructions <text>",
      "Delivery directions: tone, pace, emotion (Gemini TTS, Fish Audio, OpenAI)",
    )
    .option(
      "--format <fmt>",
      `Output ${SPEECH_FORMATS.join("|")}: auto = wav for pcm-only models (Gemini, HeyGen), mp3 otherwise; wav = pcm with a WAV header`,
      "auto",
    )
    .option(
      "--sample-rate <hz>",
      `PCM sample rate for the WAV header when OpenRouter does not state it (default ${DEFAULT_PCM_SAMPLE_RATE})`,
    )
    .option(
      "--speed <n>",
      "Speed multiplier, for models that support it (others ignore it or return 400)",
    )
    .option(
      "--provider-options <json>",
      'Provider passthrough options keyed by provider slug, e.g. {"google-ai-studio":{"temperature":0.7}}',
    )
    .option("--zdr", "Route only to Zero Data Retention endpoints")
    .option("--deny-data-collection", "Route only to providers that do not store or train on data")
    .option(
      "--no-model-check",
      "Skip checking the model and voice against OpenRouter's speech catalog",
    )
    .option(
      "--no-cost",
      "Skip reading the generation's cost from OpenRouter after the audio arrives",
    )
    .option("--cost-wait <s>", "Seconds to wait for OpenRouter to report the cost", "20")
    .option("--output <path>", "Copy the generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: TtsOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const model = (opts.model ?? DEFAULT_OPENROUTER_TTS_MODEL).trim();
      if (!model.includes("/")) {
        throw new ValidationError(
          `--model must be an OpenRouter model id like provider/name, got "${model}"`,
        );
      }
      const format: ResolvedSpeechFormat = resolveSpeechFormat(
        parseSpeechFormat(opts.format),
        model,
      );
      const sampleRateFlag = opts.sampleRate
        ? Math.round(positiveNumber(opts.sampleRate, "--sample-rate", 384_000))
        : undefined;
      const speed = opts.speed ? positiveNumber(opts.speed, "--speed", 4) : undefined;
      const costWait = Number(opts.costWait);
      if (!Number.isFinite(costWait) || costWait < 0 || costWait > 120) {
        throw new ValidationError("--cost-wait must be between 0 and 120 seconds");
      }
      const providerOptions = opts.providerOptions
        ? parseProviderOptions(opts.providerOptions)
        : undefined;
      let input = inputText(opts);
      const chars = charCount(input);
      if (chars > MAX_TEXT_CHARS) {
        throw new ValidationError(
          `The text is ${chars} characters; at most ${MAX_TEXT_CHARS} are allowed per request`,
        );
      }
      const apiKey = requireOpenRouterKey();
      const headers = buildOpenRouterHeaders(apiKey);

      let voice = opts.voice?.trim() || undefined;
      let entry: SpeechModel | undefined;
      // A dry run reports the speech request itself, so it skips the catalog GET.
      if (opts.modelCheck && !run.dryRun) {
        const checked = await checkCatalog(model, voice, input, logger);
        entry = checked.entry;
        voice = checked.voice;
        input = checked.input;
      }

      const body: SpeechRequestBody = {
        model,
        input,
        response_format: requestFormat(format),
        ...(voice ? { voice } : {}),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        ...(speed !== undefined ? { speed } : {}),
      };
      if (opts.zdr || opts.denyDataCollection || providerOptions) {
        body.provider = {
          ...(opts.zdr ? { zdr: true } : {}),
          ...(opts.denyDataCollection ? { data_collection: "deny" as const } : {}),
          ...(providerOptions ? { options: providerOptions } : {}),
        };
      }
      logger.debug(
        `TTS model=${model} voice=${voice ?? "(provider default)"} format=${format} chars=${chars}`,
      );

      const speech = await createSpeech({ body, headers, maxBytes: maxDownloadBytes() });
      const responseRate = speech.contentType.sampleRate;
      const channels = speech.contentType.channels ?? 1;
      const sampleRate = responseRate ?? sampleRateFlag ?? DEFAULT_PCM_SAMPLE_RATE;
      const sampleRateSource = responseRate ? "content-type" : sampleRateFlag ? "flag" : "assumed";

      let bytes = speech.audio;
      if (format === "mp3" && !looksLikeMp3(bytes)) {
        logger.warn(
          `${model} returned ${speech.contentType.mime ?? "unlabelled"} data that does not look like MP3`,
        );
      }
      if (format === "wav") bytes = pcmToWav(bytes, sampleRate, channels);
      const dest = writeAudio(bytes, format, opts.output);

      const isPcm = format !== "mp3";
      const mime = format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : "audio/pcm";
      let stats: GenerationStats | undefined;
      if (opts.cost && speech.generationId && costWait > 0) {
        stats = await waitForGeneration(speech.generationId, headers, costWait * 1000, logger);
      }
      const result = {
        model_requested: model,
        model_resolved: stats?.model ?? null,
        provider: stats?.providerName ?? speech.providerName ?? null,
        voice: voice ?? null,
        input_chars: chars,
        turns: Array.isArray(input) ? input.length : null,
        format,
        mime,
        response_mime: speech.contentType.mime ?? null,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sample_rate_hz: isPcm ? sampleRate : null,
        sample_rate_source: isPcm ? sampleRateSource : null,
        channels: isPcm ? channels : null,
        duration_s: isPcm
          ? pcmDurationSeconds(speech.audio.byteLength, sampleRate, channels)
          : null,
        generation_id: speech.generationId ?? null,
        cost_usd: stats?.totalCost ?? null,
        cost_source: stats?.totalCost !== undefined ? "openrouter-generation" : null,
        estimated_cost_usd: estimateCost(entry, chars),
        is_byok: stats?.isByok ?? null,
        path: dest,
        output: opts.output ? path.resolve(opts.output) : null,
      };

      if (run.json) {
        console.log(JSON.stringify(result));
        return;
      }
      logger.success(`Saved: ${dest}`);
      if (opts.output) logger.success(`Copied to: ${path.resolve(opts.output)}`);
      const details = [
        `model ${result.model_resolved ?? model}`,
        voice ? `voice ${voice}` : "",
        `${format}${isPcm ? ` ${sampleRate} Hz${sampleRateSource === "assumed" ? " (assumed)" : ""}` : ""}`,
        result.duration_s !== null ? `${result.duration_s}s` : "",
        result.cost_usd !== null ? `$${result.cost_usd}` : "",
      ].filter(Boolean);
      console.log(`  ${details.join(", ")}`);
      if (speech.generationId && result.cost_usd === null && opts.cost) {
        console.log(`  Cost not reported yet: multix openrouter generation ${speech.generationId}`);
      }
      console.log(`\nGenerated audio: ${dest}`);
    });
}
