/**
 * multix runway models — the models, ratios and limits multix validates
 * against (no API call, no key needed).
 */

import type { Command } from "commander";
import { RUNWAY_IMAGE_MODELS, RUNWAY_VIDEO_MODELS } from "../models.js";

export function registerRunwayModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List supported Runway models, ratios and limits")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        console.log(
          JSON.stringify({ video: RUNWAY_VIDEO_MODELS, image: RUNWAY_IMAGE_MODELS }, null, 2),
        );
        return;
      }
      console.log("Video (multix runway video):");
      for (const m of RUNWAY_VIDEO_MODELS) {
        console.log(`  ${m.id} — ${m.label}`);
        console.log(`    duration: ${m.minDuration}-${m.maxDuration}s`);
        if (m.textRatios.length > 0)
          console.log(`    text-to-video ratios: ${m.textRatios.join(", ")}`);
        console.log(`    image-to-video ratios: ${m.imageRatios.join(", ")}`);
      }
      console.log("\nImage (multix runway image):");
      for (const m of RUNWAY_IMAGE_MODELS) {
        console.log(`  ${m.id} — ${m.label}`);
        console.log(`    reference images: ${m.minReferences}-${m.maxReferences}`);
        console.log(`    ratios: ${m.ratios.join(", ")}`);
      }
    });
}
