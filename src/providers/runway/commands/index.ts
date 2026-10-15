/**
 * Registers the `runway` command group (Runway Dev API, api.dev.runwayml.com).
 */

import type { Command } from "commander";
import { registerRunwayCancelCommand } from "./cancel.js";
import { registerRunwayImageCommand } from "./image.js";
import { registerRunwayModelsCommand } from "./models.js";
import { registerRunwayStatusCommand } from "./status.js";
import { registerRunwayVideoCommand } from "./video.js";

export function registerRunwayCommands(program: Command): void {
  const runway = program
    .command("runway")
    .description("Runway: Gen-4.5 video, Gen-4 image, task status and cancel");

  registerRunwayVideoCommand(runway);
  registerRunwayImageCommand(runway);
  registerRunwayStatusCommand(runway);
  registerRunwayCancelCommand(runway);
  registerRunwayModelsCommand(runway);
}
