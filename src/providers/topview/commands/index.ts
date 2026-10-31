/**
 * Registers the `topview` command group. Two separate TopView surfaces:
 *
 * - Legacy API (api.topview.ai; TOPVIEW_API_KEY + TOPVIEW_UID; topview.ai plan
 *   credits): url-to-video, materials-to-video, m2v-export, video-avatar,
 *   product-avatar, product-anyshoot, status, upload, credit.
 * - API Platform (platform-backend.topview.ai; TOPVIEW_PLATFORM_API_KEY;
 *   separate USD balance): models, run, prediction.
 *
 * Neither surface has a cancel endpoint, so there is no cancel command.
 */

import type { Command } from "commander";
import { registerTopviewCreditCommand } from "./credit.js";
import { registerTopviewM2vCommands } from "./m2v.js";
import { registerTopviewModelsCommand } from "./models.js";
import { registerTopviewPredictionCommand } from "./prediction.js";
import { registerTopviewProductAnyshootCommand } from "./product-anyshoot.js";
import { registerTopviewProductAvatarCommand } from "./product-avatar.js";
import { registerTopviewRunCommand } from "./run.js";
import { registerTopviewStatusCommand } from "./status.js";
import { registerTopviewUploadCommand } from "./upload.js";
import { registerTopviewVideoAvatarCommand } from "./video-avatar.js";

export function registerTopviewCommands(program: Command): void {
  const topview = program
    .command("topview")
    .description(
      "TopView: marketing videos, avatars and product shots (Legacy API) and API Platform predictions",
    );

  registerTopviewM2vCommands(topview);
  registerTopviewVideoAvatarCommand(topview);
  registerTopviewProductAvatarCommand(topview);
  registerTopviewProductAnyshootCommand(topview);
  registerTopviewStatusCommand(topview);
  registerTopviewUploadCommand(topview);
  registerTopviewCreditCommand(topview);
  registerTopviewModelsCommand(topview);
  registerTopviewRunCommand(topview);
  registerTopviewPredictionCommand(topview);
}
