/**
 * Registers the `topview` command group: the legacy API (topview.ai plan
 * credits) and the API Platform (separate USD balance), each with its own key.
 */

import type { Command } from "commander";
import { registerAnyshootCommands } from "./anyshoot.js";
import { registerAvatarCommands } from "./avatar.js";
import { registerGenerateCommand } from "./generate.js";
import { registerMarketingVideoCommands } from "./marketing-video.js";
import { registerModelsCommand } from "./models.js";
import { registerStatusCommand } from "./status.js";
import { registerUploadCommand } from "./upload.js";

export function registerTopviewCommands(program: Command): void {
  const topview = program
    .command("topview")
    .description(
      "TopView: marketing videos, avatars, product shots (legacy API, plan credits) and API Platform video/image models (USD balance)",
    );

  registerMarketingVideoCommands(topview);
  registerAvatarCommands(topview);
  registerAnyshootCommands(topview);
  registerGenerateCommand(topview);
  registerStatusCommand(topview);
  registerUploadCommand(topview);
  registerModelsCommand(topview);
}
