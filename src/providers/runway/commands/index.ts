/**
 * Registers the `runway` command group (direct Runway API, Gen-4 family).
 */

import type { Command } from "commander";
import { registerRunwayCancelCommand } from "./cancel.js";
import { registerRunwayImageCommand } from "./image.js";
import { registerRunwayStatusCommand } from "./status.js";
import { registerRunwayVideoCommand } from "./video.js";

export function registerRunwayCommands(program: Command): void {
  const runway = program
    .command("runway")
    .description("Runway: Gen-4.5/Gen-4 Turbo video, Gen-4 images, task status and cancel");

  registerRunwayVideoCommand(runway);
  registerRunwayImageCommand(runway);
  registerRunwayStatusCommand(runway);
  registerRunwayCancelCommand(runway);
}
