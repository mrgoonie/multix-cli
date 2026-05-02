/**
 * Command registry — all top-level subcommand groups are registered here.
 * Each provider/command phase appends its registrar; cli.ts calls registerCommands once.
 */

import type { Command } from "commander";
import { registerCheckCommand } from "./check.js";
import { registerDocCommands } from "./doc/index.js";
import { registerMediaCommands } from "./media/index.js";
import { registerGeminiCommands } from "../providers/gemini/commands/index.js";
import { registerMinimaxCommands } from "../providers/minimax/commands/index.js";
import { registerOpenRouterCommands } from "../providers/openrouter/commands/index.js";

export function registerCommands(program: Command): void {
  registerCheckCommand(program);
  registerGeminiCommands(program);
  registerMinimaxCommands(program);
  registerOpenRouterCommands(program);
  registerMediaCommands(program);
  registerDocCommands(program);
}
