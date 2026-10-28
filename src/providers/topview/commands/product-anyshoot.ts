/**
 * multix topview product-anyshoot — place your product into a template scene
 * (legacy API, credits). POST /v1/product_anyShoot/task/submit, polled with
 * GET /v1/product_anyShoot/task/result
 * (https://docs.topview.ai/reference/product_anyshoot_v1), not the
 * undocumented lower-case /v1/product_anyshoot path. TopView offers no cancel.
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { assertLegacyId } from "../models.js";
import { createTopviewClient } from "../node-client.js";
import { isLocalFile, precheckLegacyFile, resolveLegacyFile } from "../node-inputs.js";
import type { AnyshootSubmitRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  checkWaitFlags,
  completeLegacyTask,
  parsePositiveInt,
  printTaskHandle,
} from "./task-flow.js";

const PROMPT_MAX = 2000;

export interface AnyshootOpts extends WaitFlagOptions {
  productImage?: string;
  productMask?: string;
  templateId?: string;
  template?: string;
  templateMask?: string;
  mode?: string;
  prompt?: string;
  count?: string;
}

/** Validate the flags; file flags are resolved to fileIds afterwards. */
export function planAnyshoot(
  opts: AnyshootOpts,
): Pick<AnyshootSubmitRequest, "mode" | "easyModePrompt" | "generatingCount" | "templateId"> {
  if (opts.productImage === undefined) throw new ValidationError("--product-image is required");
  if (opts.templateMask === undefined) throw new ValidationError("--template-mask is required");
  if ((opts.templateId === undefined) === (opts.template === undefined)) {
    throw new ValidationError("Pass exactly one of --template-id <id> or --template <path|fileId>");
  }
  const mode = opts.mode ?? "easy";
  if (mode !== "easy" && mode !== "advanced")
    throw new ValidationError("--mode must be easy or advanced");
  precheckLegacyFile(opts.productImage, "--product-image", ["image"]);
  if (
    mode === "easy" &&
    isLocalFile(opts.productImage) &&
    path.extname(opts.productImage).toLowerCase() === ".webp"
  ) {
    throw new ValidationError("--mode easy does not accept a WebP --product-image");
  }
  precheckLegacyFile(opts.templateMask, "--template-mask", ["image"]);
  if (opts.productMask !== undefined)
    precheckLegacyFile(opts.productMask, "--product-mask", ["image"]);
  if (opts.template !== undefined) precheckLegacyFile(opts.template, "--template", ["image"]);
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) throw new ValidationError("--prompt is required");
  if (prompt.length > PROMPT_MAX)
    throw new ValidationError(`--prompt is longer than ${PROMPT_MAX} characters`);
  const count = opts.count !== undefined ? parsePositiveInt(opts.count, "--count", 4) : 1;
  return {
    mode,
    easyModePrompt: prompt,
    generatingCount: String(count),
    ...(opts.templateId !== undefined
      ? { templateId: assertLegacyId(opts.templateId, "template id") }
      : {}),
  };
}

export function registerProductAnyshootCommand(parent: Command): void {
  const cmd = parent
    .command("product-anyshoot")
    .description("Product photos in a template scene (legacy API, credits: 1 per image)")
    .option("--product-image <path|fileId>", "Product image (no WebP in easy mode)")
    .option(
      "--product-mask <path|fileId>",
      "Product mask (black and white, same size as the image)",
    )
    .option("--template-id <id>", "TopView anyshoot template id")
    .option("--template <path|fileId>", "Your own template image instead of --template-id")
    .option("--template-mask <path|fileId>", "Template mask: where the product goes")
    .option("--mode <mode>", "easy (default) or advanced")
    .option("--prompt <text>", "Scene instructions (easyModePrompt)")
    .option("--count <n>", "Images to generate, 1-4 (default 1)");
  addOutputOptions(cmd, 900_000).action(async (opts: AnyshootOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
    const waitTimeoutMs = checkWaitFlags(opts, "product-anyshoot");
    const plan = planAnyshoot(opts);
    const client = createTopviewClient();
    const file = (value: string, flag: string) =>
      resolveLegacyFile(value, flag, client, logger, ["image"]);
    const request: AnyshootSubmitRequest = {
      ...plan,
      productImageFileId: await file(opts.productImage as string, "--product-image"),
      templateMaskFileId: await file(opts.templateMask as string, "--template-mask"),
    };
    if (opts.productMask !== undefined)
      request.productMaskFileId = await file(opts.productMask, "--product-mask");
    if (opts.template !== undefined)
      request.templateImageFileId = await file(opts.template, "--template");
    logger.info(
      `Billed in TopView credits: about 1 credit per image (${plan.generatingCount} requested)`,
    );
    const submitted = await client.submit("product-anyshoot", request);
    logger.success(`Created TopView product-anyshoot task ${submitted.taskId}`);
    if (!opts.wait) {
      printTaskHandle("product-anyshoot", submitted.taskId);
      return;
    }
    await completeLegacyTask(client, "product-anyshoot", submitted.taskId, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
