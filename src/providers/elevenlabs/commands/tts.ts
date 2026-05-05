/**
 * multix elevenlabs tts — text-to-speech.
 * Endpoint: POST /v1/text-to-speech/{voice_id}?output_format=...
 * Returns audio bytes synchronously.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey, saveBytes } from "../client.js";
import {
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_TTS_MODELS,
  TASK_DEFAULTS,
  extFromFormat,
} from "../models.js";

export function registerTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description("Text-to-speech (returns audio synchronously)")
    .option("--text <str>", "Text to speak (use --text or --prompt)")
    .option("--prompt <str>", "Alias for --text")
    .option("--voice <id>", "Voice ID", TASK_DEFAULTS.ttsVoice)
    .option(
      "--model <id>",
      `TTS model (${[...ELEVENLABS_TTS_MODELS].join("|")})`,
      TASK_DEFAULTS.ttsModel,
    )
    .option(
      "--format <fmt>",
      `Output format (${[...ELEVENLABS_OUTPUT_FORMATS].join("|")})`,
      TASK_DEFAULTS.ttsFormat,
    )
    .option("--stability <n>", "Voice stability 0..1", "0.5")
    .option("--similarity-boost <n>", "Voice similarity boost 0..1", "0.75")
    .option("--style <n>", "Style exaggeration 0..1", "0.0")
    .option("--speaker-boost", "Use speaker boost (default true)")
    .option("--language-code <code>", "ISO language code (Flash/Turbo/v3 only)")
    .option("--seed <n>", "Determinism seed (0..4294967295)")
    .option("--previous-text <str>", "Preceding text for context continuity")
    .option("--next-text <str>", "Following text for context continuity")
    .option("--output <path>", "Copy generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      const text = opts.text ?? opts.prompt;
      if (!text) throw new ValidationError("Either --text or --prompt is required");
      if (!opts.voice) throw new ValidationError("--voice <id> is required");

      const payload: Record<string, unknown> = {
        text,
        model_id: opts.model,
        voice_settings: {
          stability: Number.parseFloat(opts.stability),
          similarity_boost: Number.parseFloat(opts.similarityBoost),
          style: Number.parseFloat(opts.style),
          use_speaker_boost: opts.speakerBoost !== false,
        },
      };
      if (opts.languageCode) payload.language_code = opts.languageCode;
      if (opts.seed !== undefined) payload.seed = Number.parseInt(opts.seed, 10);
      if (opts.previousText) payload.previous_text = opts.previousText;
      if (opts.nextText) payload.next_text = opts.nextText;

      logger.debug(`TTS voice=${opts.voice} model=${opts.model} fmt=${opts.format}`);

      const bytes = await apiPostBinary(`text-to-speech/${opts.voice}`, payload, apiKey, {
        query: { output_format: opts.format },
      });

      const dest = saveBytes({
        bytes,
        task: "tts",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);
    });
}
