/**
 * multix sume image <prompt> -m <id> — text-to-image, or image edit with
 * --image (repeatable). Every flag is checked against the model's catalog row
 * before anything is uploaded or billed. Prints a job id unless --wait.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { SUME_IMAGE_MODEL_ENV } from "../models.js";
import { type GenerateOptions, addOutputOptions, collect, runGeneration } from "./job-flow.js";

export function registerSumeImageCommand(parent: Command): void {
  const cmd = parent
    .command("image <prompt>")
    .description("Generate or edit images via Sume; prints a job id unless --wait")
    .option(
      "-m, --model <id>",
      `Model id from \`multix sume models --kind image\` (or ${SUME_IMAGE_MODEL_ENV})`,
    )
    .option("--image <path|url>", "Input image for editing (repeatable)", collect)
    .option("--aspect-ratio <ratio>", "Aspect ratio the model lists, e.g. 16:9")
    .option(
      "--image-size <size>",
      "Output size as WIDTHxHEIGHT or a preset, for models that take it",
    )
    .option("--quality <quality>", "Quality the model lists")
    .option("--resolution <resolution>", "Resolution the model lists, e.g. 1K, 2K")
    .option("--num-images <n>", "Number of images (within the model's limit)")
    .option("--output-format <format>", "Output format the model lists, e.g. png, webp")
    .option("--param <key=value>", "Another request field the model lists (repeatable)", collect)
    .option("--idempotency-key <key>", "Reuse a key to get back a job an interrupted run created")
    .option("--wait", "Wait for the job to finish, then download the images");
  addOutputOptions(cmd, 300_000).action(async (prompt: string, opts: GenerateOptions) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    await runGeneration("image", prompt, opts, logger);
  });
}
