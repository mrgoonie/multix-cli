/**
 * Registers the `fish` command group (native Fish Audio API).
 */

import type { Command } from "commander";
import { registerFishCloneCommand } from "./clone.js";
import { registerFishTtsCommand } from "./tts.js";
import { registerFishVoiceDesignCommand } from "./voice-design.js";
import { registerFishVoicesCommand } from "./voices.js";

export function registerFishCommands(program: Command): void {
  const fish = program
    .command("fish")
    .description(
      "Fish Audio (native API): Drama 3 text-to-speech, voice design, cloning and voice models",
    );
  registerFishTtsCommand(fish);
  registerFishVoiceDesignCommand(fish);
  registerFishCloneCommand(fish);
  registerFishVoicesCommand(fish);
}
