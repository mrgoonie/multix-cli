/**
 * Registers the `openrouter` command group.
 */

import type { Command } from "commander";
import { registerOpenRouterGenerateCommand } from "./generate.js";
import { registerOpenRouterImageToVideoCommand } from "./image-to-video.js";
import { registerOpenRouterVideoModelsCommand } from "./video-models.js";
import { registerOpenRouterVideoStatusCommand } from "./video-status.js";

export function registerOpenRouterCommands(program: Command): void {
  const openrouter = program
    .command("openrouter")
    .description("OpenRouter image + video generation");

  registerOpenRouterGenerateCommand(openrouter);
  registerOpenRouterImageToVideoCommand(openrouter);
  registerOpenRouterVideoStatusCommand(openrouter);
  registerOpenRouterVideoModelsCommand(openrouter);
}
