/**
 * One thin adapter per speech provider: map a validated SpeechRoute onto the
 * provider's existing generator, write the audio with the provider's own
 * naming, and return the files (or the job id for an async submit). Each
 * adapter sends at most one billable request and never retries it.
 */

import fs from "node:fs";
import path from "node:path";
import { envDefault } from "../../core/env-default.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { atlasDefaultModel, requireAtlasKey } from "../../providers/atlascloud/commands/env.js";
import { runGenerationCommand } from "../../providers/atlascloud/commands/generation-command.js";
import { resumeCommand } from "../../providers/atlascloud/commands/prediction-runner.js";
import { FIELD_CANDIDATES as F } from "../../providers/atlascloud/model-input.js";
import {
  apiPostBinary,
  requireElevenLabsKey,
  saveBytes,
} from "../../providers/elevenlabs/client.js";
import { TASK_DEFAULTS as ELEVENLABS_DEFAULTS } from "../../providers/elevenlabs/models.js";
import { requireFalKey } from "../../providers/fal/client.js";
import { runFalTts } from "../../providers/fal/commands/tts.js";
import { FAL_DEFAULTS } from "../../providers/fal/models.js";
import { requireFishKey } from "../../providers/fish/client.js";
import { runFishTts } from "../../providers/fish/commands/tts.js";
import {
  DEFAULT_FISH_TTS_MODEL,
  FISH_TTS_MODEL_ENV,
  type FishTtsFormat,
  type FishTtsModel,
} from "../../providers/fish/models.js";
import { generateGeminiSpeech } from "../../providers/gemini/generators/speech.js";
import { listGeminiKeys } from "../../providers/gemini/key-pool.js";
import { getDefaultModel } from "../../providers/gemini/models.js";
import type { TtsOutputFormat } from "../../providers/gemini/voices.js";
import { requireMinimaxKey } from "../../providers/minimax/client.js";
import { generateMinimaxSpeech } from "../../providers/minimax/generators/speech.js";
import { TASK_DEFAULTS as MINIMAX_DEFAULTS } from "../../providers/minimax/models.js";
import { requireOpenAIKey } from "../../providers/openai/client.js";
import {
  DEFAULT_OPENAI_TTS_MODEL,
  type OpenAITtsOutputFormat,
} from "../../providers/openai/models.js";
import { generateOpenAISpeech } from "../../providers/openai/openai-audio.js";
import { requireOpenRouterKey } from "../../providers/openrouter/client.js";
import { runOpenRouterTts } from "../../providers/openrouter/commands/tts.js";
import { parseSpeechFormat } from "../../providers/openrouter/speech-audio.js";
import {
  DEFAULT_OPENROUTER_TTS_MODEL,
  OPENROUTER_TTS_MODEL_ENV,
} from "../../providers/openrouter/speech-defaults.js";
import { MINIMAX_LANGUAGE_BOOST, type SpeechProvider } from "../../speech/speech-catalog.js";
import type { SpeechInput, SpeechRoute } from "../../speech/speech-request.js";

export interface SpeechJob {
  id: string;
  /** Command that waits for the job and downloads its audio. */
  resume: string;
}

export interface SpeechAdapterResult {
  files: string[];
  job?: SpeechJob;
}

export interface SpeechContext {
  output?: string;
  logger: Logger;
  verbose: boolean;
}

export interface SpeechAdapter {
  /** Model used when only the provider is given (env overrides applied). */
  defaultModel(): string;
  /** Throws ConfigError when the provider's key is not set; sends nothing. */
  requireKey(): void;
  generate(
    route: SpeechRoute,
    input: SpeechInput,
    ctx: SpeechContext,
  ): Promise<SpeechAdapterResult>;
}

/** ElevenLabs output_format for a façade format. */
const ELEVENLABS_FORMAT: Readonly<Record<string, string>> = {
  mp3: "mp3_44100_128",
  pcm: "pcm_24000",
};

const gemini: SpeechAdapter = {
  defaultModel: () => getDefaultModel("generate-speech"),
  requireKey() {
    if (listGeminiKeys().length === 0) {
      throw new ConfigError(
        "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey",
      );
    }
  },
  async generate(route, input, ctx) {
    const result = await generateGeminiSpeech({
      text: input.text,
      model: route.model,
      voice: route.voice,
      speakers: input.speakers.length > 0 ? input.speakers : undefined,
      style: input.style,
      outputFormat: (route.format ?? "wav") as TtsOutputFormat,
      output: ctx.output,
      logger: ctx.logger,
    });
    if (result.status === "error" || !result.generatedAudio) {
      throw new ProviderError(result.error ?? "Gemini returned no audio", "gemini");
    }
    return { files: [result.generatedAudio] };
  },
};

const openai: SpeechAdapter = {
  defaultModel: () => envDefault("OPENAI_TTS_MODEL", DEFAULT_OPENAI_TTS_MODEL),
  requireKey: () => void requireOpenAIKey(),
  async generate(route, input, ctx) {
    const file = await generateOpenAISpeech({
      text: input.text,
      model: route.model,
      voice: route.voice ?? "",
      outputFormat: (route.format ?? "mp3") as OpenAITtsOutputFormat,
      instructions: input.style,
      output: ctx.output,
      logger: ctx.logger,
    });
    return { files: [file] };
  },
};

const elevenlabs: SpeechAdapter = {
  defaultModel: () => ELEVENLABS_DEFAULTS.ttsModel,
  requireKey: () => void requireElevenLabsKey(),
  async generate(route, input, ctx) {
    const apiKey = requireElevenLabsKey();
    const {
      stability,
      similarity_boost,
      style,
      use_speaker_boost,
      seed,
      previous_text,
      next_text,
    } = route.extras;
    const settings = Object.fromEntries(
      Object.entries({ stability, similarity_boost, style, use_speaker_boost }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    const payload: Record<string, unknown> = {
      text: input.text,
      model_id: route.model,
      ...(Object.keys(settings).length ? { voice_settings: settings } : {}),
      ...(input.language && route.capability.language_param
        ? { language_code: input.language }
        : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(previous_text !== undefined ? { previous_text } : {}),
      ...(next_text !== undefined ? { next_text } : {}),
    };
    const format = route.format ?? "mp3";
    const bytes = await apiPostBinary(
      `text-to-speech/${encodeURIComponent(route.voice ?? "")}`,
      payload,
      apiKey,
      {
        query: { output_format: ELEVENLABS_FORMAT[format] ?? "mp3_44100_128" },
      },
    );
    const file = saveBytes({
      bytes,
      task: "tts",
      ext: format,
      outputCopy: ctx.output,
      logger: ctx.logger,
    });
    return { files: [file] };
  },
};

const minimax: SpeechAdapter = {
  defaultModel: () => MINIMAX_DEFAULTS.speech,
  requireKey: () => void requireMinimaxKey(),
  async generate(route, input, ctx) {
    const result = await generateMinimaxSpeech({
      apiKey: requireMinimaxKey(),
      text: input.text,
      model: route.model,
      voice: route.voice,
      emotion: input.emotion,
      languageBoost: input.language ? MINIMAX_LANGUAGE_BOOST[input.language] : undefined,
      outputFormat: route.format ?? "mp3",
      rate: typeof route.extras.speed === "number" ? route.extras.speed : undefined,
      output: ctx.output,
      logger: ctx.logger,
    });
    if (result.status === "error" || !result.generatedAudio) {
      throw new ProviderError(result.error ?? "MiniMax returned no audio", "minimax");
    }
    return { files: [result.generatedAudio] };
  },
};

const ATLAS_WAIT_MS = 600_000;

const atlas: SpeechAdapter = {
  defaultModel: () => atlasDefaultModel("tts"),
  requireKey: () => void requireAtlasKey(),
  async generate(route, input, ctx) {
    const result = await runGenerationCommand({
      model: route.model,
      kind: "audio",
      requests: () => [
        { flag: "--text", value: input.text, candidates: F.speechText },
        { flag: "--voice", value: route.voice, candidates: F.voice },
        { flag: "--format", value: route.format, candidates: F.audioFormat },
        { flag: "--language", value: input.language, candidates: F.language },
      ],
      opts: { async: input.async, output: ctx.output, verbose: ctx.verbose },
      hint: "audio",
      defaultWaitTimeoutMs: ATLAS_WAIT_MS,
      pollIntervalMs: 3000,
    });
    return input.async
      ? {
          files: [],
          job: { id: result.predictionId, resume: resumeCommand(result.predictionId, ctx.output) },
        }
      : { files: result.files };
  },
};

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const fish: SpeechAdapter = {
  defaultModel: () => envDefault(FISH_TTS_MODEL_ENV, DEFAULT_FISH_TTS_MODEL),
  requireKey: () => void requireFishKey(),
  async generate(route, input, ctx) {
    const x = route.extras;
    const result = await runFishTts(
      {
        // The catalog lists only allowlisted models, so the route model is a valid header value.
        model: route.model as FishTtsModel,
        text: input.text,
        voices: route.voice ? [route.voice] : [],
        format: (route.format ?? "mp3") as FishTtsFormat,
        ...(input.language ? { language: input.language } : {}),
        ...(num(x.temperature) !== undefined ? { temperature: num(x.temperature) } : {}),
        ...(num(x.top_p) !== undefined ? { topP: num(x.top_p) } : {}),
        ...(num(x.speed) !== undefined ? { speed: num(x.speed) } : {}),
        ...(num(x.volume) !== undefined ? { volume: num(x.volume) } : {}),
        ...(num(x.chunk_length) !== undefined ? { chunkLength: num(x.chunk_length) } : {}),
        ...(typeof x.normalize === "boolean" ? { normalize: x.normalize } : {}),
        ...(typeof x.latency === "string" ? { latency: x.latency } : {}),
      },
      { output: ctx.output, logger: ctx.logger },
    );
    return { files: [result.path] };
  },
};

const openrouter: SpeechAdapter = {
  defaultModel: () => envDefault(OPENROUTER_TTS_MODEL_ENV, DEFAULT_OPENROUTER_TTS_MODEL),
  requireKey: () => void requireOpenRouterKey(),
  async generate(route, input, ctx) {
    const x = route.extras;
    const result = await runOpenRouterTts(
      {
        model: route.model,
        input: input.text,
        voice: route.voice,
        instructions: input.style,
        // No format: the model's own (mp3, or wav for pcm-only models such as Gemini).
        format: parseSpeechFormat(route.format ?? "auto"),
        speed: num(x.speed),
        zdr: x.zdr === true,
        denyDataCollection: x.deny_data_collection === true,
        // The live catalog check (a free GET) catches a model or voice typo before the paid POST.
        modelCheck: true,
        // The cost lags the audio by seconds; it stays readable by the generation id.
        costWaitSeconds: 0,
      },
      { output: ctx.output, logger: ctx.logger },
    );
    if (result.generation_id) {
      ctx.logger.info(`Cost: multix openrouter generation ${result.generation_id}`);
    }
    return { files: [result.path] };
  },
};

/** fal output_format for a façade format (ElevenLabs endpoints; Gemini has no format field). */
const FAL_FORMAT: Readonly<Record<string, string>> = {
  mp3: "mp3_44100_128",
  pcm: "pcm_24000",
};
const FAL_WAIT_MS = 480_000;

const fal: SpeechAdapter = {
  defaultModel: () => FAL_DEFAULTS.ttsModel,
  requireKey: () => void requireFalKey(),
  async generate(route, input, ctx) {
    const hasFormat = route.capability.formats?.length !== 1;
    const out = await runFalTts(
      {
        model: route.model,
        text: input.text,
        ...(route.voice ? { voice: route.voice } : {}),
        ...(input.style ? { style: input.style } : {}),
        ...(input.language && route.capability.language_param ? { language: input.language } : {}),
        ...(hasFormat && route.format ? { format: FAL_FORMAT[route.format] } : {}),
      },
      {
        detach: input.async,
        download: true,
        waitTimeoutMs: FAL_WAIT_MS,
        logger: ctx.logger,
      },
    );
    if (out.receipt && !out.result) {
      console.log(out.requestId);
      ctx.logger.info(`Fetch the audio later: ${out.receipt.result_command}`);
      return { files: [], job: { id: out.requestId, resume: out.receipt.result_command } };
    }
    if (!out.saved) throw new ProviderError("fal returned no audio", "fal");
    if (ctx.output) {
      const target = path.resolve(ctx.output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(out.saved.path, target);
    }
    return { files: [out.saved.path] };
  },
};

export const SPEECH_ADAPTERS: Readonly<Record<SpeechProvider, SpeechAdapter>> = {
  gemini,
  openai,
  elevenlabs,
  minimax,
  atlas,
  fish,
  openrouter,
  fal,
};
