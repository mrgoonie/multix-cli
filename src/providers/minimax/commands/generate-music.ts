/**
 * multix minimax generate-music — music generation with MiniMax.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { requireMinimaxKey } from "../client.js";
import { generateMinimaxMusic } from "../generators/music.js";
import { MINIMAX_MUSIC_MODELS, TASK_DEFAULTS } from "../models.js";

export function registerMinimaxGenerateMusicCommand(parent: Command): void {
  parent
    .command("generate-music")
    .description("Generate music with MiniMax")
    .option("--lyrics <str>", "Song lyrics (use --lyrics or --prompt)")
    .option("--prompt <str>", "Music style/description prompt")
    .option("--model <id>", `Music model (${[...MINIMAX_MUSIC_MODELS].join("|")})`)
    .option("--output-format <fmt>", "Audio format: mp3|wav|flac", "mp3")
    .option("--output <path>", "Copy output audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        lyrics?: string;
        prompt?: string;
        model?: string;
        outputFormat: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const apiKey = requireMinimaxKey();

        if (!opts.lyrics && !opts.prompt) {
          throw new ValidationError("Either --lyrics or --prompt is required");
        }

        const model = opts.model ?? TASK_DEFAULTS.music;

        const result = await generateMinimaxMusic({
          apiKey,
          lyrics: opts.lyrics,
          prompt: opts.prompt,
          model,
          outputFormat: opts.outputFormat,
          output: opts.output,
          logger,
        });

        if (result.status === "error") {
          logger.error(result.error ?? "Unknown error");
          process.exit(1);
        }

        console.log(`\nGenerated music: ${result.generatedAudio}`);
        if (result.durationMs) {
          console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        }
      },
    );
}
