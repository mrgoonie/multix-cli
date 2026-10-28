/**
 * Registers the `sume` command group: Sume's native REST API (not its hosted MCP).
 */

import type { Command } from "commander";
import { registerSumeGenerateCommands } from "./generate.js";
import { registerSumeModelsCommand } from "./models.js";
import { registerSumeStatusCommands } from "./status.js";

export function registerSumeCommands(program: Command): void {
  const sume = program
    .command("sume")
    .description("Sume: image and video generation (catalog models), job status, result, cancel");
  registerSumeModelsCommand(sume);
  registerSumeGenerateCommands(sume);
  registerSumeStatusCommands(sume);
}
