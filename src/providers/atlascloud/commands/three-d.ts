/**
 * multix atlas 3d [prompt] — text-to-3D, or image-to-3D with --ref.
 * Atlas serves 3D models through POST /model/generateImage; the endpoint is
 * taken from each model's published schema.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { FIELD_CANDIDATES as F } from "../model-input.js";
import { ATLAS_DEFAULT_MODELS } from "../models.js";
import { atlasDefaultModel } from "./env.js";
import { runGenerationCommand } from "./generation-command.js";
import { type RunCliOpts, addRefOption, addRunOptions } from "./prediction-runner.js";

const THREE_D_WAIT_MS = 900_000;
const THREE_D_POLL_MS = 5000;

interface ThreeDFlags extends RunCliOpts {
  model?: string;
  ref?: string[];
  format?: string;
  seed?: string;
}

export function registerAtlas3dCommand(parent: Command): void {
  const cmd = parent
    .command("3d [prompt]")
    .alias("generate-3d")
    .description(
      `Text- or image-to-3D via Atlas Cloud (defaults: ${ATLAS_DEFAULT_MODELS.textTo3d}; with --ref ${ATLAS_DEFAULT_MODELS.imageTo3d})`,
    );
  addRefOption(cmd, "Reference image for image-to-3D (local files are uploaded)")
    .option(
      "-m, --model <id>",
      "Atlas Cloud 3D model id (env: ATLASCLOUD_TEXT_TO_3D_MODEL / ATLASCLOUD_IMAGE_TO_3D_MODEL)",
    )
    .option("--format <fmt>", "Mesh format, e.g. GLB, OBJ, FBX (model-dependent)")
    .option("--seed <n>", "Seed (model-dependent)");
  addRunOptions(cmd, { waitTimeoutMs: THREE_D_WAIT_MS }).action(
    async (prompt: string | undefined, opts: ThreeDFlags) => {
      const refs = opts.ref ?? [];
      if (!prompt && refs.length === 0) {
        throw new ValidationError("Provide a prompt (text-to-3D) or --ref <image> (image-to-3D)");
      }
      await runGenerationCommand({
        model: opts.model ?? atlasDefaultModel(refs.length > 0 ? "imageTo3d" : "textTo3d"),
        kind: "image",
        endpointFromSchema: true,
        refs,
        requests: (urls) => [
          { flag: "[prompt]", value: prompt, candidates: F.prompt },
          { flag: "--ref", value: urls, candidates: F.primaryImage },
          { flag: "--format", value: opts.format, candidates: F.modelFormat },
          { flag: "--seed", value: opts.seed, candidates: F.seed },
        ],
        opts,
        hint: "3d",
        defaultWaitTimeoutMs: THREE_D_WAIT_MS,
        pollIntervalMs: THREE_D_POLL_MS,
      });
    },
  );
}
