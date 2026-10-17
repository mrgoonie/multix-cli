/**
 * multix runway models — list the supported Runway models, their modes, ratios,
 * duration bounds and reference-image limits. Offline: read from the model
 * registry, so it needs no RUNWAYML_API_SECRET and makes no request.
 */

import type { Command } from "commander";
import { listRunwayModels } from "../models.js";

export function registerRunwayModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List supported Runway models, ratios and limits (offline)")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      const models = listRunwayModels();
      if (opts.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
      console.log("Video models:");
      for (const m of models.video) {
        const modes = [m.textToVideo && "text-to-video", "image-to-video"].filter(Boolean);
        console.log(`  ${m.id}${m.default ? " (default)" : ""}`);
        console.log(`    modes: ${modes.join(", ")}`);
        console.log(`    duration: ${m.minDuration}-${m.maxDuration}s`);
        if (m.textRatios) console.log(`    text-to-video ratios: ${m.textRatios.join(", ")}`);
        console.log(`    image-to-video ratios: ${m.imageRatios.join(", ")}`);
        console.log(`    prompt: ${m.promptRequired ? "required" : "optional"}`);
        console.log(`    list price: ${m.creditsPerSecond} credits/s`);
      }
      console.log("\nImage models:");
      for (const m of models.image) {
        console.log(`  ${m.id}${m.default ? " (default)" : ""}`);
        console.log(`    references: ${m.minReferences}-${m.maxReferences}`);
        console.log(`    ratios: ${m.ratios.join(", ")}`);
        console.log(`    list price: ${m.creditsVary ? "from " : ""}${m.credits} credits/image`);
      }
    });
}
