/**
 * multix sume image <prompt> -m <model> — Sume Image Router: text-to-image,
 * or an edit with --image. The model is required (see `multix sume models`).
 * Prints the job id with check/resume/cancel commands unless --wait.
 */

import type { Command } from "commander";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import { type GenerateOpts, runGenerate } from "./generate.js";
import { addOutputOptions } from "./job-flow.js";

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

interface ImageOpts extends GenerateOpts {
  imageFormat?: string;
  webp?: boolean;
}

export function registerSumeImageCommand(parent: Command): void {
  const cmd = parent
    .command("image <prompt>")
    .description("Generate or edit images via Sume's Image Router; prints a job id unless --wait")
    .option("-m, --model <id>", "Model id (required) from `multix sume models --kind image`")
    .option(
      "--image <path|url>",
      "Reference or source image to edit (repeatable; local files are uploaded)",
      collect,
    )
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 1:1, 16:9, auto (per model)")
    .option("--image-size <size>", "Size preset or WxH, e.g. square_hd, 1024x1536")
    .option("--quality <q>", "Quality, e.g. low|medium|high (per model)")
    .option("--resolution <r>", "Resolution, e.g. 1K, 2K, 4K (per model)")
    .option("--num-images <n>", "Number of images (per model, usually 1-4)")
    .option(
      "--input <json>",
      'Extra request fields as a JSON object, e.g. \'{"output_format":"png"}\'',
    )
    .option(
      "--idempotency-key <key>",
      "Reuse the key of an earlier submit so it is not charged twice",
    )
    .option("--wait", "Wait for the job to finish, then download the images")
    .addOption(imageFormatOption())
    .addOption(noWebpOption());
  addOutputOptions(cmd, 600_000).action(async (prompt: string, opts: ImageOpts) => {
    await runGenerate({
      router: "image",
      prompt,
      opts,
      finalize: (files, body) =>
        finalizeGeneratedImages(files, {
          imageFormat: opts.imageFormat,
          webp: opts.webp,
          output: opts.output,
          logger: createLogger({ verbose: opts.verbose ?? false, stderr: true }),
          explicitProviderFormat: body.output_format !== undefined || body.format !== undefined,
        }),
    });
  });
}
