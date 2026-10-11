/**
 * Registers the `heygen` command group (HeyGen v3 API).
 */

import type { Command } from "commander";
import { registerHeygenCatalogCommands } from "./catalog.js";
import { registerHeygenLipsyncCommand } from "./lipsync.js";
import { registerHeygenModelVideoCommand } from "./model-video.js";
import { registerHeygenRunCommand } from "./run.js";
import { registerHeygenStatusCommand } from "./status.js";
import { registerHeygenTemplateCommand } from "./template.js";
import { registerHeygenTranslateCommand } from "./translate.js";
import { registerHeygenTtsCommand } from "./tts.js";
import { registerHeygenVideoAgentCommand } from "./video-agent.js";
import { registerHeygenVideoCommand } from "./video.js";

export function registerHeygenCommands(program: Command): void {
  const heygen = program
    .command("heygen")
    .description(
      "HeyGen v3: Video Agent prompt-to-video, scripted avatar videos, translation, lipsync, TTS",
    );

  registerHeygenVideoAgentCommand(heygen);
  registerHeygenVideoCommand(heygen);
  registerHeygenStatusCommand(heygen);
  registerHeygenCatalogCommands(heygen);
  registerHeygenTranslateCommand(heygen);
  registerHeygenLipsyncCommand(heygen);
  registerHeygenTtsCommand(heygen);
  registerHeygenTemplateCommand(heygen);
  registerHeygenModelVideoCommand(heygen);
  registerHeygenRunCommand(heygen);
}
