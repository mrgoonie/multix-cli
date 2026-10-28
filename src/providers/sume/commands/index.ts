/**
 * Registers the `sume` command group (direct Sume API: one key for many
 * vendors' image and video models, priced in USD).
 */

import type { Command } from "commander";
import { registerSumeCancelCommand } from "./cancel.js";
import { registerSumeImageCommand } from "./image.js";
import { registerSumeModelsCommand } from "./models.js";
import { registerSumeStatusCommand } from "./status.js";
import { registerSumeUploadCommand } from "./upload.js";
import { registerSumeVideoCommand } from "./video.js";

export function registerSumeCommands(program: Command): void {
  const sume = program
    .command("sume")
    .description(
      "Sume: image and video router (many vendors' models, USD pricing), models, job status, cancel and upload",
    );

  registerSumeImageCommand(sume);
  registerSumeVideoCommand(sume);
  registerSumeStatusCommand(sume);
  registerSumeCancelCommand(sume);
  registerSumeModelsCommand(sume);
  registerSumeUploadCommand(sume);
}
