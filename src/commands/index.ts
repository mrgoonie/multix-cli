/**
 * Command registry — all top-level subcommand groups are registered here.
 * Each provider/command phase appends its registrar; cli.ts calls registerCommands once.
 */

import type { Command } from "commander";
import { registerBytePlusCommands } from "../providers/byteplus/commands/index.js";
import { registerElevenLabsCommands } from "../providers/elevenlabs/commands/index.js";
import { registerGeminiCommands } from "../providers/gemini/commands/index.js";
import { registerLeonardoCommands } from "../providers/leonardo/commands/index.js";
import { registerMinimaxCommands } from "../providers/minimax/commands/index.js";
import { registerOpenRouterCommands } from "../providers/openrouter/commands/index.js";
import { registerCheckCommand } from "./check.js";
import { registerDocCommands } from "./doc/index.js";
import { registerMediaCommands } from "./media/index.js";

export function registerCommands(program: Command): void {
  registerCheckCommand(program);
  registerGeminiCommands(program);
  registerMinimaxCommands(program);
  registerOpenRouterCommands(program);
  registerLeonardoCommands(program);
  registerBytePlusCommands(program);
  registerElevenLabsCommands(program);
  registerMediaCommands(program);
  registerDocCommands(program);
}
