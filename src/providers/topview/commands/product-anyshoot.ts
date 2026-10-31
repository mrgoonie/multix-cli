/**
 * `topview product-anyshoot` (Legacy API, Product AnyShoot V3):
 *
 * - `--mode try-on`     POST /v3/product_anyShoot/product_model/task/submit
 *   A model wearing/holding the product. Needs the product image, a template
 *   (--template-id or --template-image) and the template mask; the product
 *   mask is optional; --count 1-4 images.
 * - `--mode background` POST /v3/product_anyShoot/product_background/task/submit
 *   The background-free product placed in a scene from a template
 *   (mode "image") or a prompt (mode "prompt"), at --location.
 *
 * Async by default; --wait polls and downloads.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { ASPECT_RATIOS, PRODUCT_SIMILARITY, assertLegacyId } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import { type PreparedFile, prepareFileInput, uploadPreparedFile } from "../node-inputs.js";
import type { LegacyTaskKind } from "../types.js";
import {
  type WaitFlagOptions,
  addWaitOptions,
  assertOneOf,
  assertWaitFlags,
  completeLegacyTask,
  nonEmpty,
  parseLocation,
  parsePositiveInt,
  printLegacyHandle,
} from "./task-flow.js";

const WAIT_TIMEOUT_MS = 900_000;
export const ANYSHOOT_MODES = ["try-on", "background"] as const;
const COUNTS = ["1", "2", "3", "4"] as const;

export interface AnyshootOpts extends WaitFlagOptions {
  mode?: string;
  productImage?: string;
  productFileId?: string;
  productMask?: string;
  templateId?: string;
  templateImage?: string;
  templateMask?: string;
  count?: string;
  prompt?: string;
  aspectRatio?: string;
  location?: string;
  similarity?: string;
}

export interface AnyshootPlan {
  kind: Extract<LegacyTaskKind, "anyshoot-try-on" | "anyshoot-background">;
  body: Record<string, unknown>;
  uploads: Array<{ field: string; file: PreparedFile }>;
}

function rejectFlags(opts: AnyshootOpts, flags: Array<[keyof AnyshootOpts, string]>, mode: string) {
  const used = flags.filter(([key]) => opts[key] !== undefined).map(([, flag]) => flag);
  if (used.length > 0) {
    throw new ValidationError(`${used.join(", ")} do(es) not apply to --mode ${mode}`);
  }
}

/** Validate every flag before any upload or paid request. */
export function planAnyshoot(opts: AnyshootOpts): AnyshootPlan {
  if (opts.mode === undefined) {
    throw new ValidationError(`--mode is required: ${ANYSHOOT_MODES.join(", ")}`);
  }
  const mode = assertOneOf(opts.mode, ANYSHOOT_MODES, "--mode");
  const body: Record<string, unknown> = {};
  const uploads: AnyshootPlan["uploads"] = [];

  if ((opts.productImage === undefined) === (opts.productFileId === undefined)) {
    throw new ValidationError(
      "Pass exactly one product: --product-image <path|url> or --product-file-id <fileId>",
    );
  }
  const productField =
    mode === "try-on" ? "productImageFileId" : "productImageWithoutBackgroundFileId";
  if (opts.productImage !== undefined) {
    uploads.push({
      field: productField,
      file: prepareFileInput(opts.productImage, "--product-image", ["image"]),
    });
  } else {
    body[productField] = assertLegacyId(opts.productFileId as string, "--product-file-id");
  }

  if (mode === "try-on") {
    rejectFlags(
      opts,
      [
        ["prompt", "--prompt"],
        ["aspectRatio", "--aspect-ratio"],
        ["location", "--location"],
        ["similarity", "--similarity"],
      ],
      mode,
    );
    if ((opts.templateId === undefined) === (opts.templateImage === undefined)) {
      throw new ValidationError(
        "--mode try-on needs exactly one template: --template-id <id> or --template-image <path|url>",
      );
    }
    if (opts.templateMask === undefined) {
      throw new ValidationError("--mode try-on needs --template-mask <path|url>");
    }
    const templateId = nonEmpty(opts.templateId, "--template-id", 128);
    if (templateId) body.templateId = templateId;
    if (opts.templateImage !== undefined) {
      uploads.push({
        field: "templateImageFileId",
        file: prepareFileInput(opts.templateImage, "--template-image", ["image"]),
      });
    }
    uploads.push({
      field: "templateMaskFileId",
      file: prepareFileInput(opts.templateMask, "--template-mask", ["image"]),
    });
    if (opts.productMask !== undefined) {
      uploads.push({
        field: "productMaskFileId",
        file: prepareFileInput(opts.productMask, "--product-mask", ["image"]),
      });
    }
    // The API types generatingCount as a string enum.
    body.generatingCount = assertOneOf(opts.count ?? "1", COUNTS, "--count");
    return { kind: "anyshoot-try-on", body, uploads };
  }

  rejectFlags(
    opts,
    [
      ["productMask", "--product-mask"],
      ["templateMask", "--template-mask"],
      ["count", "--count"],
    ],
    mode,
  );
  const sources = [opts.templateId, opts.templateImage, opts.prompt].filter((v) => v !== undefined);
  if (sources.length !== 1) {
    throw new ValidationError(
      "--mode background needs exactly one scene: --template-id <id>, --template-image <path|url> or --prompt <text>",
    );
  }
  if (opts.location === undefined) {
    throw new ValidationError(
      "--mode background needs --location (where the product goes), e.g. [[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]",
    );
  }
  if (opts.prompt !== undefined) {
    body.mode = "prompt";
    body.prompt = nonEmpty(opts.prompt, "--prompt");
  } else {
    body.mode = "image";
    const templateId = nonEmpty(opts.templateId, "--template-id", 128);
    if (templateId) body.templateId = templateId;
    if (opts.templateImage !== undefined) {
      uploads.push({
        field: "templateImageFileId",
        file: prepareFileInput(opts.templateImage, "--template-image", ["image"]),
      });
    }
  }
  body.location = parseLocation(opts.location);
  if (opts.aspectRatio !== undefined) {
    body.aspectRatio = assertOneOf(opts.aspectRatio, ASPECT_RATIOS, "--aspect-ratio");
  }
  if (opts.similarity !== undefined) {
    body.productSimilarity = assertOneOf(opts.similarity, PRODUCT_SIMILARITY, "--similarity");
  }
  return { kind: "anyshoot-background", body, uploads };
}

export function registerTopviewProductAnyshootCommand(parent: Command): void {
  const cmd = parent
    .command("product-anyshoot")
    .description(
      "Legacy API: product photos on a model (try-on) or in a new scene (background); prints a task id unless --wait",
    )
    .option("--mode <mode>", "try-on or background (required)")
    .option(
      "--product-image <path|url>",
      "Product image (png, jpg, jpeg, bmp, webp); background-free for --mode background",
    )
    .option("--product-file-id <fileId>", "An uploaded product fileId instead of --product-image")
    .option("--product-mask <path|url>", "try-on: product mask, same size as the product image")
    .option("--template-id <id>", "Template id from the TopView template list")
    .option("--template-image <path|url>", "Your own template image")
    .option("--template-mask <path|url>", "try-on (required): mask of the template area to replace")
    .option("--count <n>", "try-on: images to generate, 1-4 (default 1)")
    .option("--prompt <text>", "background: describe the scene instead of a template")
    .option("--aspect-ratio <ratio>", `background: ${ASPECT_RATIOS.join(", ")} (default 1:1)`)
    .option(
      "--location <json>",
      "background (required): product placement, four [x,y] points, e.g. [[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]",
    )
    .option("--similarity <level>", "background: natural (default) or creative");
  addWaitOptions(cmd, WAIT_TIMEOUT_MS).action(async (opts: AnyshootOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const plan = planAnyshoot(opts);
    assertWaitFlags(opts, `multix topview status ${plan.kind} <taskId> --wait --download`);
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const client = createTopviewLegacyClient();
    const body = { ...plan.body };
    for (const { field, file } of plan.uploads) {
      body[field] = await uploadPreparedFile(client, file, logger);
    }
    logger.info(`TopView product anyshoot (${opts.mode})`);
    const submitted =
      plan.kind === "anyshoot-try-on"
        ? await client.submitProductModel(body)
        : await client.submitProductBackground(body);
    logger.success(`Created TopView ${plan.kind} task ${submitted.taskId}`);
    if (!opts.wait) {
      printLegacyHandle(plan.kind, submitted.taskId);
      return;
    }
    await completeLegacyTask(client, plan.kind, submitted.taskId, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
