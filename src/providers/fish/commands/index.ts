/**
 * Registers the `fish` command group (native Fish Audio API).
 */

import type { Command } from "commander";
import { registerFishTtsCommand } from "./tts.js";
import { registerFishVoicesCommand } from "./voices.js";

export function registerFishCommands(program: Command): void {
  const fish = program
    .command("fish")
    .description("Fish Audio (native API): Drama 3 text-to-speech and voice models");
  registerFishTtsCommand(fish);
  registerFishVoicesCommand(fish);
}
