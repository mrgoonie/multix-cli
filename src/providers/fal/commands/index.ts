/**
 * Registers the `fal` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerFalImageCommand } from "./image.js";
import { registerFalResultCommand } from "./result.js";
import { registerFalRunCommand } from "./run.js";
import { registerFalStatusCommand } from "./status.js";
import { registerFalVideoCommand } from "./video.js";

export function registerFalCommands(program: Command): void {
  const fal = program
    .command("fal")
    .description("fal.ai: generic model runner, image, video, and queue status/result");

  registerFalRunCommand(fal);
  registerFalImageCommand(fal);
  registerFalVideoCommand(fal);
  registerFalStatusCommand(fal);
  registerFalResultCommand(fal);
}
