/**
 * Product AnyShoot V3 on the legacy API (plan credits):
 * - `topview product-anyshoot model`: the product worn or held by a model
 *   (POST /v3/product_anyShoot/product_model/task/submit);
 * - `topview product-anyshoot background`: the product in a new scene
 *   (POST /v3/product_anyShoot/product_background/task/submit).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import {
  createLegacyClientFromEnv,
  createTopviewLogger,
  optionalFile,
  resolveLegacyFile,
} from "./env.js";
import { compact, mergeExtra, oneOf } from "./json-input.js";
import { type TaskCliOpts, addTaskOptions, runLegacyTask } from "./task-runner.js";

const WAIT_MS = 900_000;
const COUNTS = ["1", "2", "3", "4"] as const;
const BG_MODES = ["image", "prompt"] as const;
const ASPECT_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9"] as const;
const SIMILARITY = ["natural", "creative"] as const;

interface ModelFlags extends TaskCliOpts {
  product: string;
  productMask?: string;
  templateId?: string;
  templateImage?: string;
  templateMask: string;
  count: string;
  extra?: string;
}

interface BackgroundFlags extends TaskCliOpts {
  product: string;
  mode: string;
  templateId?: string;
  templateImage?: string;
  prompt?: string;
  aspectRatio?: string;
  similarity?: string;
  extra?: string;
}

export function registerAnyshootCommands(parent: Command): void {
  const anyshoot = parent
    .command("product-anyshoot")
    .description("Product AnyShoot: product photos on a model or in a new scene (legacy API)");

  addTaskOptions(
    anyshoot
      .command("model")
      .description("Product on a model from a template (plan credits)")
      .requiredOption("--product <pathOrAsset>", "Product image (productImageFileId)")
      .option("--product-mask <pathOrAsset>", "Product mask, same size as the product image")
      .option("--template-id <id>", "Template id from TopView's template list")
      .option("--template-image <pathOrAsset>", "Your own template image instead of --template-id")
      .requiredOption("--template-mask <pathOrAsset>", "Template mask (templateMaskFileId)")
      .option("--count <n>", "Images to generate: 1-4", "1")
      .option("--extra <json>", "More documented fields as a JSON object or @file.json"),
    WAIT_MS,
  ).action(async (opts: ModelFlags) => {
    const generatingCount = oneOf(opts.count, COUNTS, "--count");
    if (opts.templateId === undefined && opts.templateImage === undefined) {
      throw new ValidationError("Provide --template-id <id> or --template-image <pathOrAsset>");
    }
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    const client = createLegacyClientFromEnv();
    const body = compact({
      productImageFileId: await resolveLegacyFile(client, opts.product, logger),
      productMaskFileId: await optionalFile(client, opts.productMask, logger),
      templateId: opts.templateId,
      templateImageFileId: await optionalFile(client, opts.templateImage, logger),
      templateMaskFileId: await resolveLegacyFile(client, opts.templateMask, logger),
      generatingCount,
    });
    await runLegacyTask({
      client,
      logger,
      kind: "anyshoot-model",
      body: mergeExtra(body, opts.extra),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "image",
    });
  });

  addTaskOptions(
    anyshoot
      .command("background")
      .description("Product in a new background from a template or a prompt (plan credits)")
      .requiredOption(
        "--product <pathOrAsset>",
        "Product image without background (productImageWithoutBackgroundFileId)",
      )
      .requiredOption("--mode <mode>", "image (template) or prompt")
      .option("--template-id <id>", "Template id (mode image)")
      .option("--template-image <pathOrAsset>", "Your own scene image (mode image)")
      .option("--prompt <text>", "Scene description (mode prompt)")
      .option("--aspect-ratio <ratio>", `Aspect ratio: ${ASPECT_RATIOS.join(", ")} (default 1:1)`)
      .option("--similarity <s>", "natural (default) or creative (productSimilarity)")
      .option("--extra <json>", "More documented fields (e.g. location) as JSON or @file.json"),
    WAIT_MS,
  ).action(async (opts: BackgroundFlags) => {
    const mode = oneOf(opts.mode, BG_MODES, "--mode");
    if (mode === "image" && opts.templateId === undefined && opts.templateImage === undefined) {
      throw new ValidationError("--mode image needs --template-id or --template-image");
    }
    if (mode === "prompt" && !opts.prompt?.trim()) {
      throw new ValidationError("--mode prompt needs --prompt <text>");
    }
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    const client = createLegacyClientFromEnv();
    const body = compact({
      mode,
      productImageWithoutBackgroundFileId: await resolveLegacyFile(client, opts.product, logger),
      templateId: opts.templateId,
      templateImageFileId: await optionalFile(client, opts.templateImage, logger),
      prompt: opts.prompt,
      aspectRatio: oneOf(opts.aspectRatio, ASPECT_RATIOS, "--aspect-ratio"),
      productSimilarity: oneOf(opts.similarity, SIMILARITY, "--similarity"),
    });
    await runLegacyTask({
      client,
      logger,
      kind: "anyshoot-background",
      body: mergeExtra(body, opts.extra),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "image",
    });
  });
}
