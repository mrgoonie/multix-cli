/**
 * Registers the `minimax` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerMinimaxGenerateMusicCommand } from "./generate-music.js";
import { registerMinimaxGenerateSpeechCommand } from "./generate-speech.js";
import { registerMinimaxGenerateVideoCommand } from "./generate-video.js";
import { registerMinimaxGenerateCommand } from "./generate.js";

export function registerMinimaxCommands(program: Command): void {
  const minimax = program
    .command("minimax")
    .description("MiniMax generation: images, video, speech, and music");

  registerMinimaxGenerateCommand(minimax);
  registerMinimaxGenerateVideoCommand(minimax);
  registerMinimaxGenerateSpeechCommand(minimax);
  registerMinimaxGenerateMusicCommand(minimax);
}
