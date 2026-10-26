/**
 * multix openrouter transcribe — speech-to-text through OpenRouter's
 * transcription endpoint (POST /api/v1/audio/transcriptions). Any model
 * OpenRouter lists works: Whisper, GPT transcribe, Gemini 3.5 Transcribe,
 * ElevenLabs Scribe v2, Voxtral, AssemblyAI, Deepgram, Fish Audio, ...
 *
 * A local file is uploaded as multipart (at most 25 MB); an http(s) URL is
 * passed to the provider, which downloads it (only some providers accept
 * URLs). The model is checked against the live catalog before the paid
 * request, which is sent once; the resolved model and cost are then read from
 * /generation. The transcript is written to a file and never logged.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { safeUrl } from "../../../agent/fetch-telemetry.js";
import { run } from "../../../agent/run-state.js";
import { envDefault } from "../../../core/env-default.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { requireOpenRouterKey } from "../client.js";
import { buildOpenRouterHeaders } from "../payload.js";
import type { GenerationStats } from "../speech-client.js";
import {
  AUDIO_FORMAT,
  DEFAULT_OPENROUTER_STT_MODEL,
  MAX_UPLOAD_BYTES,
  type TranscriptionAudio,
  type TranscriptionModel,
  checkAudioUrl,
  createTranscription,
  findTranscriptionModel,
  listTranscriptionModels,
} from "../transcription-client.js";
import { waitForGeneration } from "./generation.js";

export const OPENROUTER_STT_MODEL_ENV = "OPENROUTER_STT_MODEL";
const LANGUAGE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

interface TranscribeOptions {
  input: string;
  model?: string;
  language?: string;
  audioFormat?: string;
  modelCheck: boolean;
  cost: boolean;
  costWait: string;
  output?: string;
  verbose?: boolean;
}

function formatOf(name: string, flag: string | undefined): string | undefined {
  const format = (flag ?? path.extname(name).slice(1)).toLowerCase();
  if (!format) return undefined;
  if (!AUDIO_FORMAT.test(format)) {
    throw new ValidationError(
      `Audio format "${format}" is not valid; pass --audio-format (e.g. mp3, wav, m4a, ogg, webm, flac)`,
    );
  }
  return format;
}

interface ResolvedInput {
  audio: TranscriptionAudio;
  /** File name, or the URL without its query string (signed URLs stay private). */
  name: string;
  bytes: number | null;
  sha256: string | null;
}

/** A local file (read under the upload cap) or an http(s) URL for the provider to download. */
export function resolveInput(input: string, audioFormat: string | undefined): ResolvedInput {
  if (/^https?:\/\//i.test(input)) {
    const url = checkAudioUrl(input);
    const format = formatOf(url.pathname, audioFormat);
    if (!format) {
      throw new ValidationError(
        "The audio URL has no file extension; pass --audio-format (e.g. mp3, wav, m4a)",
      );
    }
    return {
      audio: { kind: "url", url: input, format },
      name: safeUrl(input),
      bytes: null,
      sha256: null,
    };
  }
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`--input file not found: ${input}`);
  }
  const size = fs.statSync(resolved).size;
  if (size === 0) throw new ValidationError(`--input file is empty: ${input}`);
  if (size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `--input is ${(size / 1024 / 1024).toFixed(1)} MB; OpenRouter uploads are limited to 25 MB. Compress it (mp3/opus), split it, or pass a public URL instead`,
    );
  }
  const format = formatOf(resolved, audioFormat);
  if (!format) {
    throw new ValidationError(
      "--input has no file extension; pass --audio-format (e.g. mp3, wav, m4a)",
    );
  }
  const data = new Uint8Array(fs.readFileSync(resolved));
  return {
    audio: { kind: "bytes", data, format },
    name: path.basename(resolved),
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function writeTranscript(text: string, output: string | undefined): string {
  const dest = path.join(getOutputDir(), `openrouter_transcript_${outputStamp()}.txt`);
  fs.writeFileSync(dest, text);
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dest, target);
  }
  return dest;
}

export function registerOpenRouterTranscribeCommand(parent: Command): void {
  parent
    .command("transcribe")
    .description(
      "Speech-to-text via OpenRouter /audio/transcriptions (Whisper, GPT transcribe, Gemini 3.5 Transcribe, ElevenLabs Scribe, Voxtral, ...)",
    )
    .requiredOption(
      "--input <file|url>",
      "Audio file (uploaded, at most 25 MB) or public http(s) URL (downloaded by the provider; not every provider accepts URLs)",
    )
    .option(
      "--model <id>",
      `Transcription model (env ${OPENROUTER_STT_MODEL_ENV}), e.g. openai/whisper-large-v3-turbo, google/gemini-3.5-transcribe, elevenlabs/scribe-v2, mistralai/voxtral-mini-transcribe-3-0`,
      envDefault(OPENROUTER_STT_MODEL_ENV, DEFAULT_OPENROUTER_STT_MODEL),
    )
    .option("--language <code>", "ISO-639-1 language of the audio (auto-detected when omitted)")
    .option(
      "--audio-format <fmt>",
      "Audio format when the input has no extension (mp3, wav, m4a, ogg, webm, flac, ...)",
    )
    .option(
      "--no-model-check",
      "Skip checking the model against OpenRouter's transcription catalog",
    )
    .option(
      "--no-cost",
      "Skip reading the resolved model and cost from OpenRouter's generation record",
    )
    .option("--cost-wait <s>", "Seconds to wait for OpenRouter to record the generation", "20")
    .option("--output <path>", "Copy the transcript to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: TranscribeOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const model = (opts.model ?? DEFAULT_OPENROUTER_STT_MODEL).trim();
      if (!model.includes("/")) {
        throw new ValidationError(
          `--model must be an OpenRouter model id like provider/name, got "${model}"`,
        );
      }
      const language = opts.language?.trim() || undefined;
      if (language && !LANGUAGE.test(language)) {
        throw new ValidationError(
          `--language must be an ISO-639-1 code like en or ja, got "${language}"`,
        );
      }
      const costWait = Number(opts.costWait);
      if (!Number.isFinite(costWait) || costWait < 0 || costWait > 120) {
        throw new ValidationError("--cost-wait must be between 0 and 120 seconds");
      }
      const input = resolveInput(opts.input, opts.audioFormat);
      const headers = buildOpenRouterHeaders(requireOpenRouterKey());

      let entry: TranscriptionModel | undefined;
      // A dry run reports the transcription request itself, so it skips the catalog GET.
      if (opts.modelCheck && !run.dryRun) {
        entry = findTranscriptionModel(await listTranscriptionModels(), model);
        if (!entry) {
          throw new ValidationError(
            `Model ${model} is not an OpenRouter transcription model (model not found in ?output_modalities=transcription). List them with: multix openrouter transcription-models (or pass --no-model-check for a model OpenRouter does not list yet)`,
          );
        }
      }
      logger.debug(
        `STT model=${entry?.id ?? model} input=${input.audio.kind} format=${input.audio.format ?? "?"} bytes=${input.bytes ?? "?"}`,
      );

      const result = await createTranscription({
        model: entry?.id ?? model,
        audio: input.audio,
        ...(language ? { language } : {}),
        headers,
      });
      const dest = writeTranscript(result.text, opts.output);

      let stats: GenerationStats | undefined;
      if (opts.cost && result.generationId && costWait > 0) {
        stats = await waitForGeneration(result.generationId, headers, costWait * 1000, logger);
      }
      const costUsd = stats?.totalCost ?? result.usage.cost ?? null;
      const out = {
        model_requested: model,
        model_resolved: stats?.model ?? null,
        provider: stats?.providerName ?? null,
        input: input.name,
        input_kind: input.audio.kind === "url" ? "url" : "file",
        input_bytes: input.bytes,
        input_sha256: input.sha256,
        audio_format: input.audio.format ?? null,
        language: language ?? null,
        language_detected: result.language ?? null,
        duration_s: result.durationS ?? null,
        text: result.text,
        chars: result.text.length,
        generation_id: result.generationId ?? null,
        cost_usd: costUsd,
        cost_source:
          stats?.totalCost !== undefined
            ? "openrouter-generation"
            : result.usage.cost !== undefined
              ? "openrouter-usage"
              : null,
        is_byok: stats?.isByok ?? null,
        input_tokens: result.usage.inputTokens ?? null,
        output_tokens: result.usage.outputTokens ?? null,
        path: dest,
        output: opts.output ? path.resolve(opts.output) : null,
      };

      if (run.json) {
        console.log(JSON.stringify(out));
        return;
      }
      logger.success(`Saved transcript: ${dest}`);
      if (opts.output) logger.success(`Copied to: ${out.output}`);
      const details = [
        `model ${out.model_resolved ?? model}`,
        out.duration_s !== null ? `${out.duration_s}s of audio` : "",
        `${out.chars} chars`,
        out.cost_usd !== null ? `$${out.cost_usd}` : "",
      ].filter(Boolean);
      console.log(`  ${details.join(", ")}`);
      console.log(`\nTranscript: ${dest}`);
    });
}
