/**
 * multix atlas image <prompt>       — text-to-image
 * multix atlas image-to-image ...   — edit / restyle reference images
 */

import type { Command } from "commander";
import { FIELD_CANDIDATES as F, type FieldRequest } from "../model-input.js";
import { ATLAS_DEFAULT_MODELS } from "../models.js";
import { atlasDefaultModel } from "./env.js";
import { runGenerationCommand } from "./generation-command.js";
import { type RunCliOpts, addRefOption, addRunOptions, requireRefs } from "./prediction-runner.js";

const IMAGE_WAIT_MS = 300_000;
const IMAGE_POLL_MS = 2000;

interface ImageFlags extends RunCliOpts {
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  numImages?: string;
  seed?: string;
  negativePrompt?: string;
}

function imageRequests(prompt: string | undefined, o: ImageFlags): FieldRequest[] {
  return [
    { flag: "--prompt", value: prompt, candidates: F.prompt },
    { flag: "--size", value: o.size, candidates: F.size },
    { flag: "--aspect-ratio", value: o.aspectRatio, candidates: F.aspectRatio },
    { flag: "--resolution", value: o.resolution, candidates: F.resolution },
    { flag: "--num-images", value: o.numImages, candidates: F.numImages },
    { flag: "--seed", value: o.seed, candidates: F.seed },
    { flag: "--negative-prompt", value: o.negativePrompt, candidates: F.negativePrompt },
  ];
}

function addImageFlags(cmd: Command): Command {
  return cmd
    .option("--size <size>", "Output size in the model's format (e.g. 1024*1024 or 1024x1024)")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 1:1, 16:9 (model-dependent)")
    .option("--resolution <res>", "Resolution tier, e.g. 1k, 2k (model-dependent)")
    .option("-n, --num-images <n>", "Number of images (model-dependent)")
    .option("--seed <n>", "Seed")
    .option("--negative-prompt <text>", "Negative prompt (model-dependent)");
}

export function registerAtlasImageCommands(parent: Command): void {
  const image = parent
    .command("image <prompt>")
    .description(`Text-to-image via Atlas Cloud (default: ${ATLAS_DEFAULT_MODELS.image})`)
    .option("-m, --model <id>", "Atlas Cloud image model id (env: ATLASCLOUD_IMAGE_MODEL)");
  addImageFlags(image);
  addRunOptions(image, { waitTimeoutMs: IMAGE_WAIT_MS, images: true }).action(
    async (prompt: string, opts: ImageFlags) => {
      await runGenerationCommand({
        model: opts.model ?? atlasDefaultModel("image"),
        kind: "image",
        requests: () => imageRequests(prompt, opts),
        opts,
        hint: "image",
        defaultWaitTimeoutMs: IMAGE_WAIT_MS,
        pollIntervalMs: IMAGE_POLL_MS,
      });
    },
  );

  const edit = parent
    .command("image-to-image")
    .description(
      `Edit or restyle reference images via Atlas Cloud (default: ${ATLAS_DEFAULT_MODELS.imageEdit})`,
    )
    .requiredOption("--prompt <text>", "Edit instruction");
  addRefOption(edit, "Reference image; local files are uploaded first; required").option(
    "-m, --model <id>",
    "Atlas Cloud image-edit model id (env: ATLASCLOUD_IMAGE_EDIT_MODEL)",
  );
  addImageFlags(edit);
  addRunOptions(edit, { waitTimeoutMs: IMAGE_WAIT_MS, images: true }).action(
    async (opts: ImageFlags & { prompt: string; ref: string[] }) => {
      await runGenerationCommand({
        model: opts.model ?? atlasDefaultModel("imageEdit"),
        kind: "image",
        refs: requireRefs(opts.ref),
        requests: (refs) => [
          ...imageRequests(opts.prompt, opts),
          { flag: "--ref", value: refs, candidates: F.editImages },
        ],
        opts,
        hint: "image",
        defaultWaitTimeoutMs: IMAGE_WAIT_MS,
        pollIntervalMs: IMAGE_POLL_MS,
      });
    },
  );
}
