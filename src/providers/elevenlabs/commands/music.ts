/**
 * multix elevenlabs music — text-to-music.
 * Endpoint: POST /v1/music (sync, returns audio bytes).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey, saveBytes } from "../client.js";
import { ELEVENLABS_OUTPUT_FORMATS, TASK_DEFAULTS, extFromFormat } from "../models.js";

export function registerMusicCommand(parent: Command): void {
  parent
    .command("music")
    .description("Generate music from a text prompt or composition plan")
    .option("--prompt <str>", "Music prompt (mutually exclusive with --plan)")
    .option("--plan <path>", "Path to composition plan JSON file")
    .option("--music-length-ms <n>", "Total length in milliseconds (default 30000)")
    .option("--model <id>", "Music model", "music_v1")
    .option(
      "--format <fmt>",
      `Output format (${[...ELEVENLABS_OUTPUT_FORMATS].join("|")})`,
      TASK_DEFAULTS.musicFormat,
    )
    .option("--output <path>", "Copy to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();
      if (!opts.prompt && !opts.plan) {
        throw new ValidationError("Provide --prompt or --plan");
      }

      const payload: Record<string, unknown> = { model_id: opts.model };
      if (opts.prompt) payload.prompt = opts.prompt;
      if (opts.plan) {
        const planPath = path.resolve(opts.plan);
        if (!fs.existsSync(planPath)) throw new ValidationError(`Plan file not found: ${planPath}`);
        const planJson = JSON.parse(fs.readFileSync(planPath, "utf8"));
        payload.composition_plan = planJson;
      }
      if (opts.musicLengthMs) payload.music_length_ms = Number.parseInt(opts.musicLengthMs, 10);

      logger.debug(`Music gen with model ${opts.model}`);
      const bytes = await apiPostBinary("music", payload, apiKey, {
        query: { output_format: opts.format },
        timeoutMs: 600_000,
      });
      const dest = saveBytes({
        bytes,
        task: "music",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated music: ${dest}`);
    });
}
