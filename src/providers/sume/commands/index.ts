/**
 * Registers the `sume` command group (direct Sume API: one key for many
 * image, video, lip-sync and caption models, billed in USD).
 */

import type { Command } from "commander";
import { registerSumeCancelCommand } from "./cancel.js";
import { registerSumeEstimateCommand } from "./estimate.js";
import { registerSumeImageCommand } from "./image.js";
import { registerSumeModelsCommand } from "./models.js";
import { registerSumeStatusCommand } from "./status.js";
import { registerSumeVideoCommand } from "./video.js";

export function registerSumeCommands(program: Command): void {
  const sume = program
    .command("sume")
    .description("Sume: image and video models on one key; models, status, cancel and quotes");

  registerSumeImageCommand(sume);
  registerSumeVideoCommand(sume);
  registerSumeStatusCommand(sume);
  registerSumeCancelCommand(sume);
  registerSumeEstimateCommand(sume);
  registerSumeModelsCommand(sume);
}
