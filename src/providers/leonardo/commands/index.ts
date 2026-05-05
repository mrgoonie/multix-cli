/**
 * Registers the `leonardo` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerLeonardoGenerateCommand } from "./generate.js";
import { registerLeonardoImageToImageCommand } from "./image-to-image.js";
import { registerLeonardoImageToVideoCommand } from "./image-to-video.js";
import { registerLeonardoMeCommand } from "./me.js";
import { registerLeonardoModelsCommand } from "./models.js";
import { registerLeonardoStatusCommand } from "./status.js";
import { registerLeonardoUpscaleCommands } from "./upscale.js";
import { registerLeonardoVideoModelsCommand } from "./video-models.js";
import { registerLeonardoVideoCommand } from "./video.js";

export function registerLeonardoCommands(program: Command): void {
  const leonardo = program
    .command("leonardo")
    .description("Leonardo.Ai: image/video generation, upscaling, account info");

  registerLeonardoGenerateCommand(leonardo);
  registerLeonardoImageToImageCommand(leonardo);
  registerLeonardoVideoCommand(leonardo);
  registerLeonardoImageToVideoCommand(leonardo);
  registerLeonardoVideoModelsCommand(leonardo);
  registerLeonardoUpscaleCommands(leonardo);
  registerLeonardoStatusCommand(leonardo);
  registerLeonardoModelsCommand(leonardo);
  registerLeonardoMeCommand(leonardo);
}
