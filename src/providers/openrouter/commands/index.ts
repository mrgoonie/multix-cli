/**
 * Registers the `openrouter` command group.
 */

import type { Command } from "commander";
import { registerOpenRouterGenerateCommand } from "./generate.js";

export function registerOpenRouterCommands(program: Command): void {
  const openrouter = program
    .command("openrouter")
    .description("OpenRouter image generation via chat completions API");

  registerOpenRouterGenerateCommand(openrouter);
}
