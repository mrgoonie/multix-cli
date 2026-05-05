/**
 * multix elevenlabs voice-changer — Speech-to-Speech.
 * Endpoint: POST /v1/speech-to-speech/{voice_id}?output_format=...
 * Multipart upload of source audio; returns transformed audio bytes.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, readFileAsBlob, requireElevenLabsKey, saveBytes } from "../client.js";
import { ELEVENLABS_OUTPUT_FORMATS, TASK_DEFAULTS, extFromFormat } from "../models.js";

export function registerVoiceChangerCommand(parent: Command): void {
  parent
    .command("voice-changer")
    .description("Speech-to-speech: transform an audio file to use a different voice")
    .requiredOption("--input <path>", "Source audio file")
    .requiredOption("--voice <id>", "Target voice ID")
    .option("--model <id>", "Voice changer model", TASK_DEFAULTS.voiceChangerModel)
    .option(
      "--format <fmt>",
      `Output format (${[...ELEVENLABS_OUTPUT_FORMATS].join("|")})`,
      TASK_DEFAULTS.ttsFormat,
    )
    .option("--remove-background-noise", "Server-side noise removal", false)
    .option("--stability <n>", "0..1", "0.5")
    .option("--similarity-boost <n>", "0..1", "0.75")
    .option("--style <n>", "0..1", "0.0")
    .option("--output <path>", "Copy output to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      const form = new FormData();
      form.append("audio", readFileAsBlob(opts.input));
      form.append("model_id", opts.model);
      form.append(
        "voice_settings",
        JSON.stringify({
          stability: Number.parseFloat(opts.stability),
          similarity_boost: Number.parseFloat(opts.similarityBoost),
          style: Number.parseFloat(opts.style),
        }),
      );
      if (opts.removeBackgroundNoise) form.append("remove_background_noise", "true");

      logger.debug(`Voice changer voice=${opts.voice} input=${opts.input}`);
      const bytes = await apiPostBinary(`speech-to-speech/${opts.voice}`, form, apiKey, {
        query: { output_format: opts.format },
        timeoutMs: 300_000,
      });

      if (!bytes || bytes.length === 0) {
        throw new ValidationError("Empty response from voice-changer");
      }

      const dest = saveBytes({
        bytes,
        task: "voice_changer",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);
    });
}
