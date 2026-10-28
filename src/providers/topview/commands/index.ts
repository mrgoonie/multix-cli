/**
 * Registers the `topview` command group. Two separate TopView APIs:
 * - Legacy API (credits; TOPVIEW_API_KEY + TOPVIEW_UID): url-to-video,
 *   materials-to-video, export, video-avatar, product-avatar,
 *   product-anyshoot, upload, credits
 * - API Platform (USD; TOPVIEW_PLATFORM_API_KEY): models, generate
 * `status` resumes a task of either kind. TopView does not offer cancel.
 */

import type { Command } from "commander";
import { registerAccountCommands } from "./account.js";
import { registerMarketingCommands } from "./marketing.js";
import { registerPlatformCommands } from "./platform.js";
import { registerProductAnyshootCommand } from "./product-anyshoot.js";
import { registerProductAvatarCommand } from "./product-avatar.js";
import { registerStatusCommand } from "./status.js";
import { registerVideoAvatarCommand } from "./video-avatar.js";

export function registerTopviewCommands(program: Command): void {
  const topview = program
    .command("topview")
    .description(
      "TopView: marketing videos, avatars and product shots (credits), plus API Platform models (USD). TopView does not offer cancel",
    );

  registerMarketingCommands(topview);
  registerVideoAvatarCommand(topview);
  registerProductAvatarCommand(topview);
  registerProductAnyshootCommand(topview);
  registerStatusCommand(topview);
  registerAccountCommands(topview);
  registerPlatformCommands(topview);
}
