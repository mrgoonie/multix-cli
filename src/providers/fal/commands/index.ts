/**
 * Registers the `fal` command group and all subcommands.
 */

import type { Command } from "commander";
import { registerFalImageCommand } from "./image.js";
import { registerFalModelsCommand } from "./models.js";
import { registerFalResultCommand } from "./result.js";
import { registerFalRunCommand } from "./run.js";
import { registerFalStatusCommand } from "./status.js";
import { registerFalTtsCommand } from "./tts.js";
import { registerFalUploadCommand } from "./upload.js";
import { registerFalVideoCommand } from "./video.js";

export function registerFalCommands(program: Command): void {
  const fal = program
    .command("fal")
    .description(
      "fal.ai: generic model runner, image, video, text-to-speech, model catalog, media upload, and queue status/result",
    );

  registerFalRunCommand(fal);
  registerFalImageCommand(fal);
  registerFalVideoCommand(fal);
  registerFalTtsCommand(fal);
  registerFalModelsCommand(fal);
  registerFalStatusCommand(fal);
  registerFalResultCommand(fal);
  registerFalUploadCommand(fal);
}
