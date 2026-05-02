/**
 * Registers the `minimax` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerMinimaxGenerateCommand } from "./generate.js";
import { registerMinimaxGenerateVideoCommand } from "./generate-video.js";
import { registerMinimaxGenerateSpeechCommand } from "./generate-speech.js";
import { registerMinimaxGenerateMusicCommand } from "./generate-music.js";

export function registerMinimaxCommands(program: Command): void {
  const minimax = program
    .command("minimax")
    .description("MiniMax generation: images, video, speech, and music");

  registerMinimaxGenerateCommand(minimax);
  registerMinimaxGenerateVideoCommand(minimax);
  registerMinimaxGenerateSpeechCommand(minimax);
  registerMinimaxGenerateMusicCommand(minimax);
}
