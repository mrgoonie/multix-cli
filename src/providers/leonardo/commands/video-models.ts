/**
 * multix leonardo video-models — list supported video models (static enum).
 */

import type { Command } from "commander";
import { LEONARDO_VIDEO_MODELS, LEONARDO_VIDEO_RESOLUTIONS } from "../models.js";

export function registerLeonardoVideoModelsCommand(parent: Command): void {
  parent
    .command("video-models")
    .description("List supported Leonardo video models (static enum from Leonardo docs)")
    .action(() => {
      for (const m of LEONARDO_VIDEO_MODELS) {
        console.log(`${m.id}\t${m.name}\t[${m.modes.join(",")}]`);
      }
      console.error(`\nResolutions: ${LEONARDO_VIDEO_RESOLUTIONS.join(", ")}`);
      console.error("Source: https://docs.leonardo.ai/llms.txt");
    });
}
