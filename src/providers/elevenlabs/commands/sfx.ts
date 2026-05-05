/**
 * multix elevenlabs sfx — text-to-sound-effects.
 * Endpoint: POST /v1/sound-generation (sync, returns audio bytes).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey, saveBytes } from "../client.js";
import { ELEVENLABS_OUTPUT_FORMATS, TASK_DEFAULTS, extFromFormat } from "../models.js";

export function registerSfxCommand(parent: Command): void {
  parent
    .command("sfx")
    .description("Generate sound effects from a text prompt")
    .option("--text <str>", "Sound description (alias: --prompt)")
    .option("--prompt <str>", "Alias for --text")
    .option("--duration-seconds <n>", "Target duration 0.5..30 (auto if omitted)")
    .option("--prompt-influence <n>", "0..1 (default 0.3)", "0.3")
    .option("--loop", "Loop-friendly output", false)
    .option(
      "--format <fmt>",
      `Output format (${[...ELEVENLABS_OUTPUT_FORMATS].join("|")})`,
      TASK_DEFAULTS.sfxFormat,
    )
    .option("--output <path>", "Copy to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();
      const text = opts.text ?? opts.prompt;
      if (!text) {
        const { ValidationError } = await import("../../../core/errors.js");
        throw new ValidationError("--text or --prompt is required");
      }

      const payload: Record<string, unknown> = {
        text,
        prompt_influence: Number.parseFloat(opts.promptInfluence),
        loop: opts.loop,
      };
      if (opts.durationSeconds) payload.duration_seconds = Number.parseFloat(opts.durationSeconds);

      logger.debug(`SFX: "${text.slice(0, 60)}..."`);
      const bytes = await apiPostBinary("sound-generation", payload, apiKey, {
        query: { output_format: opts.format },
        timeoutMs: 300_000,
      });
      const dest = saveBytes({
        bytes,
        task: "sfx",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated SFX: ${dest}`);
    });
}
