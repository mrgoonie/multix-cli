/**
 * multix runway models — list the supported Runway models and their request
 * limits from the local registry (VIDEO_MODELS / IMAGE_MODELS). Offline: no
 * API secret and no request. `default` marks the model used without -m
 * (RUNWAY_VIDEO_MODEL / RUNWAY_IMAGE_MODEL when set).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import {
  IMAGE_MODELS,
  type ImageModelSpec,
  VIDEO_MODELS,
  type VideoModelSpec,
  formatCredits,
} from "../models.js";
import { runwayImageModel, runwayVideoModel } from "../node-client.js";

export interface RunwayModelList {
  video: Array<
    { id: string; default: boolean; textToVideo: boolean; imageToVideo: true } & VideoModelSpec
  >;
  image: Array<{ id: string; default: boolean } & ImageModelSpec>;
}

export function listRunwayModels(defaults: { video: string; image: string }): RunwayModelList {
  return {
    video: Object.entries(VIDEO_MODELS).map(([id, spec]) => ({
      id,
      default: id === defaults.video,
      textToVideo: Boolean(spec.textRatios),
      imageToVideo: true,
      ...spec,
    })),
    image: Object.entries(IMAGE_MODELS).map(([id, spec]) => ({
      id,
      default: id === defaults.image,
      ...spec,
    })),
  };
}

function printModels(list: RunwayModelList): void {
  console.log("Video models (multix runway video):");
  for (const m of list.video) {
    console.log(`  ${m.id}${m.default ? " (default)" : ""}`);
    console.log(
      `    text-to-video:  ${m.textRatios ? m.textRatios.join(", ") : "no (needs --image)"}`,
    );
    console.log(`    image-to-video: ${m.imageRatios.join(", ")}`);
    console.log(
      `    duration: ${m.minDuration}-${m.maxDuration}s; prompt ${m.promptRequired ? "required" : "optional"}`,
    );
    console.log(`    list price: ${formatCredits(m.creditsPerSecond)} per second`);
  }
  console.log("\nImage models (multix runway image):");
  for (const m of list.image) {
    console.log(`  ${m.id}${m.default ? " (default)" : ""}`);
    console.log(`    ratios: ${m.ratios.join(", ")}`);
    console.log(`    references: ${m.minReferences}-${m.maxReferences}`);
    console.log(
      `    list price: ${m.creditsVary ? "from " : ""}${formatCredits(m.credits)} per image`,
    );
  }
}

export function registerRunwayModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List supported Runway models, ratios, durations and reference limits (offline)")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      const defaults = { video: runwayVideoModel(), image: runwayImageModel() };
      const logger = createLogger({ verbose: false, stderr: true });
      if (!VIDEO_MODELS[defaults.video]) {
        logger.warn(`RUNWAY_VIDEO_MODEL="${defaults.video}" is not a supported video model`);
      }
      if (!IMAGE_MODELS[defaults.image]) {
        logger.warn(`RUNWAY_IMAGE_MODEL="${defaults.image}" is not a supported image model`);
      }
      const list = listRunwayModels(defaults);
      if (opts.json) console.log(JSON.stringify(list, null, 2));
      else printModels(list);
    });
}
