/**
 * multix topview product-avatar — an avatar presenting your product (legacy
 * API, credits), chained over the documented V3 steps
 * (https://docs.topview.ai/reference/pa3_getting_started):
 *
 *   1. remove-background:       product image  → cutout fileId
 *   2. product-avatar-replace:  cutout + avatar/template → image(s) with the product
 *   3. product-avatar-video:    one image + script → video
 *
 * Steps 1-2 are always waited for (each needs the previous output). Every
 * step's task id is printed, and the chain resumes from any step:
 * --product-cutout skips step 1, --replace-image-id skips steps 1-2.
 * The undocumented single-call /v1/product_avatar/task/submit is not used.
 * TopView offers no cancel.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { TopviewTaskError } from "../client.js";
import { assertLegacyId } from "../models.js";
import { createTopviewClient } from "../node-client.js";
import { precheckLegacyFile, resolveLegacyFile } from "../node-inputs.js";
import type { ProductImage2VideoSubmitRequest, ProductReplaceSubmitRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  checkWaitFlags,
  completeLegacyTask,
  parsePositiveInt,
  printTaskHandle,
  waitLegacyTask,
} from "./task-flow.js";

const VIDEO_MODES = ["avatar2", "avatar4", "avatar4Fast"] as const;
const TTS_MAX = 5000;

export interface ProductAvatarOpts extends WaitFlagOptions {
  productImage?: string;
  productCutout?: string;
  replaceImageId?: string;
  avatarId?: string;
  template?: string;
  imageMode?: string;
  editPrompt?: string;
  location?: string;
  imageIndex?: string;
  replaceOnly?: boolean;
  videoMode?: string;
  ttsText?: string;
  voiceId?: string;
  audio?: string;
  captionId?: string;
}

export interface ProductAvatarPlan {
  start: "remove-background" | "replace" | "video";
  replace?: Omit<
    ProductReplaceSubmitRequest,
    "productImageWithoutBackgroundFileId" | "templateImageFileId"
  >;
  video?: Omit<ProductImage2VideoSubmitRequest, "replaceProductTaskImageId" | "audioFileId">;
  imageIndex: number;
}

/** location: four [x, y] corner points, each coordinate normalized to 0-1. */
export function parseLocation(raw: string): number[][] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      "--location must be JSON, e.g. [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]",
    );
  }
  const ok =
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1),
    );
  if (!ok) {
    throw new ValidationError("--location must be four [x, y] points with coordinates from 0 to 1");
  }
  return value as number[][];
}

/** Validate every flag before anything is uploaded or submitted. */
export function planProductAvatar(opts: ProductAvatarOpts): ProductAvatarPlan {
  const starts = [opts.productImage, opts.productCutout, opts.replaceImageId].filter(
    (v) => v !== undefined,
  );
  if (starts.length !== 1) {
    throw new ValidationError(
      "Pass exactly one of --product-image <path|fileId>, --product-cutout <fileId> or --replace-image-id <imageId>",
    );
  }
  const start =
    opts.productImage !== undefined
      ? "remove-background"
      : opts.productCutout !== undefined
        ? "replace"
        : "video";
  const plan: ProductAvatarPlan = {
    start,
    imageIndex:
      opts.imageIndex !== undefined ? parsePositiveInt(opts.imageIndex, "--image-index") : 1,
  };
  if (opts.productImage !== undefined)
    precheckLegacyFile(opts.productImage, "--product-image", ["image"]);
  if (opts.productCutout !== undefined) assertLegacyId(opts.productCutout, "cutout fileId");
  if (opts.replaceImageId !== undefined) assertLegacyId(opts.replaceImageId, "replace image id");

  if (start !== "video") {
    if ((opts.avatarId === undefined) === (opts.template === undefined)) {
      throw new ValidationError("Pass exactly one of --avatar-id <id> or --template <path|fileId>");
    }
    if (opts.template !== undefined) precheckLegacyFile(opts.template, "--template", ["image"]);
    const mode = opts.imageMode ?? "auto";
    if (mode !== "auto" && mode !== "manual") {
      throw new ValidationError("--image-mode must be auto or manual");
    }
    if (mode === "manual" && opts.location === undefined) {
      throw new ValidationError("--image-mode manual needs --location");
    }
    if (mode === "auto" && opts.location !== undefined) {
      throw new ValidationError("--location applies to --image-mode manual only");
    }
    plan.replace = { generateImageMode: mode };
    if (opts.avatarId !== undefined)
      plan.replace.avatarId = assertLegacyId(opts.avatarId, "avatar id");
    if (opts.editPrompt !== undefined) {
      if (mode !== "auto")
        throw new ValidationError("--edit-prompt applies to --image-mode auto only");
      const prompt = opts.editPrompt.trim();
      if (!prompt) throw new ValidationError("--edit-prompt must not be empty");
      plan.replace.imageEditPrompt = prompt;
    }
    if (opts.location !== undefined) plan.replace.location = parseLocation(opts.location);
  } else if (opts.avatarId !== undefined || opts.template !== undefined) {
    throw new ValidationError(
      "--avatar-id and --template apply before --replace-image-id; drop them",
    );
  }

  if (opts.replaceOnly) {
    if (start === "video")
      throw new ValidationError("--replace-only cannot start from --replace-image-id");
    return plan;
  }
  if (opts.videoMode === undefined) {
    throw new ValidationError(
      `--video-mode is required: ${VIDEO_MODES.join(", ")} (or pass --replace-only to stop after the product image)`,
    );
  }
  if (!(VIDEO_MODES as readonly string[]).includes(opts.videoMode)) {
    throw new ValidationError(`--video-mode must be one of: ${VIDEO_MODES.join(", ")}`);
  }
  if ((opts.audio === undefined) === (opts.ttsText === undefined)) {
    throw new ValidationError(
      "Pass exactly one script: --tts-text <text> (with --voice-id) or --audio <path|fileId>",
    );
  }
  const video: ProductAvatarPlan["video"] = {
    mode: opts.videoMode as ProductImage2VideoSubmitRequest["mode"],
    scriptMode: opts.audio !== undefined ? "audio" : "text",
  };
  if (opts.audio !== undefined) {
    precheckLegacyFile(opts.audio, "--audio", ["audio"]);
    if (opts.voiceId !== undefined)
      throw new ValidationError("--voice-id applies to --tts-text only");
  } else {
    const tts = (opts.ttsText ?? "").trim();
    if (!tts) throw new ValidationError("--tts-text must not be empty");
    if (tts.length > TTS_MAX)
      throw new ValidationError(`--tts-text is longer than ${TTS_MAX} characters`);
    if (opts.voiceId === undefined) throw new ValidationError("--tts-text needs --voice-id");
    video.ttsText = tts;
    video.voiceId = assertLegacyId(opts.voiceId, "voice id");
  }
  if (opts.captionId !== undefined) video.captionId = assertLegacyId(opts.captionId, "caption id");
  plan.video = video;
  return plan;
}

export function registerProductAvatarCommand(parent: Command): void {
  const cmd = parent
    .command("product-avatar")
    .description(
      "Avatar holding your product: remove background → place product → video (legacy API, credits; resumable)",
    )
    .option("--product-image <path|fileId>", "Product photo (starts at background removal)")
    .option(
      "--product-cutout <fileId>",
      "Resume: product image without background (bgRemovedImageFileId)",
    )
    .option("--replace-image-id <imageId>", "Resume: an image from the replace step")
    .option("--avatar-id <id>", "Public product avatar id")
    .option("--template <path|fileId>", "Your own template image instead of --avatar-id")
    .option("--image-mode <mode>", "auto (default) or manual (needs --location)")
    .option("--edit-prompt <text>", "Instructions for auto placement")
    .option("--location <json>", "Manual placement: four [x, y] points, 0-1")
    .option("--image-index <n>", "Which replace result to animate (default 1)")
    .option("--replace-only", "Stop after the replace step")
    .option("--video-mode <mode>", `Video model: ${VIDEO_MODES.join(", ")}`)
    .option("--tts-text <text>", "Text to speak")
    .option("--voice-id <id>", "Voice for --tts-text")
    .option(
      "--audio <path|fileId>",
      "Speech audio instead of --tts-text (avatar2 max 28s, avatar4 max 120s)",
    )
    .option("--caption-id <id>", "Caption style id");
  addOutputOptions(cmd, 900_000).action(async (opts: ProductAvatarOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
    const waitTimeoutMs = checkWaitFlags(opts, "product-avatar-video");
    const plan = planProductAvatar(opts);
    const client = createTopviewClient();
    const audioFileId =
      opts.audio !== undefined
        ? await resolveLegacyFile(opts.audio, "--audio", client, logger, ["audio"])
        : undefined;
    const step = (name: string, id: string) => logger.info(`Step ${name}: task ${id}`);
    logger.info("Billed in TopView credits (replacement 1 credit; video per second by mode)");

    let cutout = opts.productCutout;
    if (plan.start === "remove-background") {
      const imageId = await resolveLegacyFile(
        opts.productImage as string,
        "--product-image",
        client,
        logger,
        ["image"],
      );
      const removal = await client.submit("remove-background", { productImageFileId: imageId });
      step("remove-background", removal.taskId);
      const done = await waitLegacyTask(client, "remove-background", removal.taskId, {
        waitTimeoutMs,
        logger,
      });
      if (!done.bgRemovedImageFileId) {
        throw new TopviewTaskError({
          ...done,
          status: "fail",
          errorMsg: "no bgRemovedImageFileId in the result",
        });
      }
      cutout = done.bgRemovedImageFileId;
      logger.info(`Cutout fileId: ${cutout} (resume with --product-cutout ${cutout})`);
    }

    let imageId = opts.replaceImageId;
    let faceExistence: boolean | undefined;
    if (plan.start !== "video") {
      const replace: ProductReplaceSubmitRequest = {
        ...(plan.replace as NonNullable<ProductAvatarPlan["replace"]>),
        productImageWithoutBackgroundFileId: cutout as string,
      };
      if (opts.template !== undefined) {
        replace.templateImageFileId = await resolveLegacyFile(
          opts.template,
          "--template",
          client,
          logger,
          ["image"],
        );
      }
      const submitted = await client.submit("product-avatar-replace", replace);
      step("product-avatar-replace", submitted.taskId);
      if (opts.replaceOnly) {
        if (!opts.wait) {
          printTaskHandle("product-avatar-replace", submitted.taskId);
          return;
        }
        await completeLegacyTask(client, "product-avatar-replace", submitted.taskId, {
          waitTimeoutMs,
          logger,
          download: opts.download !== false,
          rawUrls: opts.download === false,
          output: opts.output,
        });
        return;
      }
      const done = await waitLegacyTask(client, "product-avatar-replace", submitted.taskId, {
        waitTimeoutMs,
        logger,
      });
      const image = done.images?.[plan.imageIndex - 1];
      if (!image?.imageId) {
        throw new ValidationError(
          `The replace step returned ${done.images?.length ?? 0} image(s); --image-index ${plan.imageIndex} has no imageId`,
        );
      }
      imageId = image.imageId;
      faceExistence = image.faceExistence;
      logger.info(`Replace image id: ${imageId} (resume with --replace-image-id ${imageId})`);
    }

    const video = plan.video as NonNullable<ProductAvatarPlan["video"]>;
    if (faceExistence === false && video.mode !== "avatar2") {
      throw new ValidationError(
        `The product image has no face, so only --video-mode avatar2 works. Resume with --replace-image-id ${imageId} --video-mode avatar2`,
      );
    }
    const request: ProductImage2VideoSubmitRequest = {
      ...video,
      replaceProductTaskImageId: imageId as string,
      ...(audioFileId !== undefined ? { audioFileId } : {}),
    };
    const submitted = await client.submit("product-avatar-video", request);
    step("product-avatar-video", submitted.taskId);
    if (!opts.wait) {
      printTaskHandle("product-avatar-video", submitted.taskId);
      return;
    }
    await completeLegacyTask(client, "product-avatar-video", submitted.taskId, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
