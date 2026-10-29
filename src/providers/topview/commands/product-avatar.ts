/**
 * `topview product-avatar` (Legacy API, Product Avatar V3): the documented
 * three-stage chain, each stage a separate paid task:
 *
 * 1. remove background  POST /v1/common_task/remove_background/submit
 *    (productImageFileId → bgRemovedImageFileId)
 * 2. image replace      POST /v3/product_avatar/task/image_replace/submit
 *    (productImageWithoutBackgroundFileId + avatarId | templateImageFileId → imageId)
 * 3. image to video     POST /v3/product_avatar/task/image2Video/submit
 *    (replaceProductTaskImageId → finished video)
 *
 * The chain always waits for each stage. Every stage logs its task id and the
 * command that resumes from the next stage. A stage is never resubmitted
 * automatically: a failure that may have created a task stops the chain with
 * the orphan hint, and `--bg-removed-file-id` / `--replace-image-id` skip
 * the stages that already succeeded.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { TopviewTaskError } from "../errors.js";
import type { TopviewLegacyClient } from "../legacy-client.js";
import { GENERATE_IMAGE_MODES, PRODUCT_AVATAR_MODES, assertLegacyId } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import { type PreparedFile, prepareFileInput, uploadPreparedFile } from "../node-inputs.js";
import type { LegacyTask, ReplaceProductImage } from "../types.js";
import {
  assertOneOf,
  legacyResumeCommand,
  nonEmpty,
  parseLocation,
  parsePositiveInt,
  reportLegacyOutputs,
  waitLegacyTask,
} from "./task-flow.js";

const WAIT_TIMEOUT_MS = 1_800_000;

export interface ProductAvatarOpts {
  productImage?: string;
  bgRemovedFileId?: string;
  replaceImageId?: string;
  avatarId?: string;
  templateImage?: string;
  generateImageMode?: string;
  imageEditPrompt?: string;
  location?: string;
  mode?: string;
  ttsText?: string;
  voiceId?: string;
  audio?: string;
  captionId?: string;
  waitTimeout: string;
  /** undefined (no flag) and true both mean "download". */
  download?: boolean;
  output?: string;
  verbose?: boolean;
}

export type ProductAvatarStart = "remove-bg" | "replace" | "video";

export interface ProductAvatarPlan {
  start: ProductAvatarStart;
  /** Stage 1 input (start "remove-bg"). */
  productImage?: PreparedFile;
  /** Stage 2 input when resuming with --bg-removed-file-id. */
  bgRemovedFileId?: string;
  /** Stage 3 input when resuming with --replace-image-id. */
  replaceImageId?: string;
  /** Stage 2 body without productImageWithoutBackgroundFileId / templateImageFileId. */
  replaceBody?: Record<string, unknown>;
  templateImage?: PreparedFile;
  /** Stage 3 body without replaceProductTaskImageId / audioFileId. */
  videoBody: Record<string, unknown>;
  audio?: PreparedFile;
  mode: (typeof PRODUCT_AVATAR_MODES)[number];
}

/** Validate every flag of every remaining stage before any upload or paid request. */
export function planProductAvatar(opts: ProductAvatarOpts): ProductAvatarPlan {
  const starts = [opts.productImage, opts.bgRemovedFileId, opts.replaceImageId].filter(
    (v) => v !== undefined,
  );
  if (starts.length !== 1) {
    throw new ValidationError(
      "Pass exactly one of --product-image <path|url> (full chain), --bg-removed-file-id <fileId> (resume at stage 2) or --replace-image-id <imageId> (resume at stage 3)",
    );
  }
  const start: ProductAvatarStart =
    opts.productImage !== undefined
      ? "remove-bg"
      : opts.bgRemovedFileId !== undefined
        ? "replace"
        : "video";

  // Stage 3 flags: always needed.
  if (opts.mode === undefined) {
    throw new ValidationError(`--mode is required: ${PRODUCT_AVATAR_MODES.join(", ")}`);
  }
  const mode = assertOneOf(opts.mode, PRODUCT_AVATAR_MODES, "--mode");
  if ((opts.audio === undefined) === (opts.ttsText === undefined)) {
    throw new ValidationError(
      "Pass exactly one script source: --tts-text <text> or --audio <file>",
    );
  }
  const videoBody: Record<string, unknown> = { mode };
  let audio: PreparedFile | undefined;
  const voiceId = nonEmpty(opts.voiceId, "--voice-id", 128);
  if (opts.ttsText !== undefined) {
    if (!voiceId) throw new ValidationError("--tts-text needs --voice-id");
    videoBody.scriptMode = "text";
    videoBody.ttsText = nonEmpty(opts.ttsText, "--tts-text", 20_000);
    videoBody.voiceId = voiceId;
  } else {
    if (voiceId) throw new ValidationError("--voice-id applies to --tts-text only");
    videoBody.scriptMode = "audio";
    audio = prepareFileInput(opts.audio as string, "--audio", ["audio"]);
  }
  const captionId = nonEmpty(opts.captionId, "--caption-id", 128);
  if (captionId) videoBody.captionId = captionId;

  const stage2Flags = [
    opts.avatarId,
    opts.templateImage,
    opts.generateImageMode,
    opts.imageEditPrompt,
    opts.location,
  ];
  if (start === "video") {
    if (stage2Flags.some((v) => v !== undefined)) {
      throw new ValidationError(
        "--replace-image-id resumes at stage 3: drop --avatar-id, --template-image, --generate-image-mode, --image-edit-prompt and --location",
      );
    }
    return {
      start,
      replaceImageId: assertLegacyId(opts.replaceImageId as string, "--replace-image-id"),
      videoBody,
      ...(audio ? { audio } : {}),
      mode,
    };
  }

  // Stage 2 flags.
  if ((opts.avatarId === undefined) === (opts.templateImage === undefined)) {
    throw new ValidationError(
      "Pass exactly one avatar: --avatar-id <id> (public product avatar) or --template-image <path|url>",
    );
  }
  const generateImageMode = assertOneOf(
    opts.generateImageMode ?? "auto",
    GENERATE_IMAGE_MODES,
    "--generate-image-mode",
  );
  // The API lists templateImageFileId and imageEditPrompt as required; "" is their documented default.
  const replaceBody: Record<string, unknown> = {
    generateImageMode,
    templateImageFileId: "",
    imageEditPrompt: "",
  };
  const avatarId = nonEmpty(opts.avatarId, "--avatar-id", 128);
  if (avatarId) replaceBody.avatarId = avatarId;
  if (generateImageMode === "auto") {
    if (opts.location !== undefined) {
      throw new ValidationError("--location applies to --generate-image-mode manual only");
    }
    const prompt = nonEmpty(opts.imageEditPrompt, "--image-edit-prompt");
    if (!prompt) {
      throw new ValidationError("--generate-image-mode auto needs --image-edit-prompt");
    }
    replaceBody.imageEditPrompt = prompt;
  } else {
    if (opts.imageEditPrompt !== undefined) {
      throw new ValidationError("--image-edit-prompt applies to --generate-image-mode auto only");
    }
    if (opts.location === undefined) {
      throw new ValidationError("--generate-image-mode manual needs --location");
    }
    replaceBody.location = parseLocation(opts.location);
  }
  const templateImage =
    opts.templateImage !== undefined
      ? prepareFileInput(opts.templateImage, "--template-image", ["image"])
      : undefined;

  return {
    start,
    ...(start === "remove-bg"
      ? {
          productImage: prepareFileInput(opts.productImage as string, "--product-image", ["image"]),
        }
      : {
          bgRemovedFileId: assertLegacyId(opts.bgRemovedFileId as string, "--bg-removed-file-id"),
        }),
    replaceBody,
    ...(templateImage ? { templateImage } : {}),
    videoBody,
    ...(audio ? { audio } : {}),
    mode,
  };
}

/**
 * The replace result to animate: the first with a face unless the mode is
 * avatar2 (TopView: "If faceExistence=false, only mode=avatar2 can be selected").
 */
export function pickReplaceResult(
  task: LegacyTask,
  mode: ProductAvatarPlan["mode"],
): ReplaceProductImage {
  const results = task.replaceResults ?? [];
  const usable = mode === "avatar2" ? results : results.filter((r) => r.faceExistence !== false);
  const chosen = usable[0];
  if (!chosen) {
    throw new TopviewTaskError(
      task,
      results.length === 0
        ? ": the image replace stage returned no image"
        : `: no replaced image has a face, so --mode ${mode} cannot animate it (use --mode avatar2: multix topview product-avatar --replace-image-id ${results[0]?.imageId} --mode avatar2 ...)`,
    );
  }
  return chosen;
}

/** Shell-free placeholder for the flags the user already passed. */
const STAGE3_FLAGS = "--mode <mode> <--tts-text/--voice-id or --audio>";

async function runStage(
  client: TopviewLegacyClient,
  kind: "remove-bg" | "product-avatar-replace" | "product-avatar-video",
  label: string,
  submit: (resumeHint: string) => Promise<{ taskId: string }>,
  resumeHint: string,
  ctx: { logger: Logger; waitTimeoutMs: number; nextHint: (id: string) => string },
): Promise<LegacyTask> {
  const { taskId } = await submit(resumeHint);
  ctx.logger.success(`${label}: created TopView ${kind} task ${taskId}`);
  ctx.logger.info(
    `If this run stops, resume this stage with: ${legacyResumeCommand(kind, taskId)}`,
  );
  return waitLegacyTask(client, kind, taskId, {
    waitTimeoutMs: ctx.waitTimeoutMs,
    logger: ctx.logger,
    resumeHint: `Do not submit this stage again. Resume with: ${legacyResumeCommand(kind, taskId)}, then ${ctx.nextHint(taskId)}`,
  });
}

export async function runProductAvatar(opts: ProductAvatarOpts): Promise<LegacyTask> {
  const logger = createLogger({ verbose: opts.verbose ?? false });
  const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
  const plan = planProductAvatar(opts);
  const client = createTopviewLegacyClient();
  const ctx = { logger, waitTimeoutMs };

  // Uploads are free; do them all before the first paid stage.
  const productImageFileId = plan.productImage
    ? await uploadPreparedFile(client, plan.productImage, logger)
    : undefined;
  const templateImageFileId = plan.templateImage
    ? await uploadPreparedFile(client, plan.templateImage, logger)
    : undefined;
  const audioFileId = plan.audio ? await uploadPreparedFile(client, plan.audio, logger) : undefined;

  let bgRemovedFileId = plan.bgRemovedFileId;
  if (plan.start === "remove-bg") {
    const stage = await runStage(
      client,
      "remove-bg",
      "Stage 1/3 (remove background)",
      (hint) => client.submitRemoveBackground({ productImageFileId }, hint),
      "Nothing later in the chain was submitted. Do not rerun the whole command until the credit log shows whether stage 1 was created",
      {
        ...ctx,
        nextHint: () =>
          "multix topview product-avatar --bg-removed-file-id <bgRemovedImageFileId> ...",
      },
    );
    bgRemovedFileId = stage.bgRemovedImageFileId;
    if (!bgRemovedFileId) {
      throw new TopviewTaskError(
        stage,
        ": the remove background stage returned no bgRemovedImageFileId",
      );
    }
    logger.info(
      `Stage 1 done. Resume from stage 2: multix topview product-avatar --bg-removed-file-id ${bgRemovedFileId} <stage 2 and 3 flags>`,
    );
  }

  let replaceImageId = plan.replaceImageId;
  if (plan.start !== "video") {
    const body = {
      ...plan.replaceBody,
      productImageWithoutBackgroundFileId: bgRemovedFileId,
      ...(templateImageFileId ? { templateImageFileId } : {}),
    };
    const stage = await runStage(
      client,
      "product-avatar-replace",
      "Stage 2/3 (image replace)",
      (hint) => client.submitImageReplace(body, hint),
      `Earlier stages succeeded; restart from stage 2 only after checking the credit log: multix topview product-avatar --bg-removed-file-id ${bgRemovedFileId} <stage 2 and 3 flags>`,
      {
        ...ctx,
        nextHint: () =>
          `multix topview product-avatar --replace-image-id <imageId> ${STAGE3_FLAGS}`,
      },
    );
    const chosen = pickReplaceResult(stage, plan.mode);
    replaceImageId = chosen.imageId;
    logger.info(
      `Stage 2 done (image ${chosen.imageId}). Resume from stage 3: multix topview product-avatar --replace-image-id ${chosen.imageId} ${STAGE3_FLAGS}`,
    );
  }

  const videoBody = {
    ...plan.videoBody,
    replaceProductTaskImageId: replaceImageId,
    ...(audioFileId ? { audioFileId } : {}),
  };
  const final = await runStage(
    client,
    "product-avatar-video",
    "Stage 3/3 (image to video)",
    (hint) => client.submitImage2Video(videoBody, hint),
    `Earlier stages succeeded; restart from stage 3 only after checking the credit log: multix topview product-avatar --replace-image-id ${replaceImageId} ${STAGE3_FLAGS}`,
    { ...ctx, nextHint: () => "download the video" },
  );
  await reportLegacyOutputs(final, {
    logger,
    download: opts.download !== false,
    rawUrls: opts.download === false,
    output: opts.output,
  });
  return final;
}

export function registerTopviewProductAvatarCommand(parent: Command): void {
  parent
    .command("product-avatar")
    .description(
      "Legacy API: product avatar video (V3 chain: remove background → image replace → image to video; 3 paid tasks, always waits)",
    )
    .option("--product-image <path|url>", "Stage 1: product image (png, jpg, jpeg, bmp, webp)")
    .option(
      "--bg-removed-file-id <fileId>",
      "Resume at stage 2 with a background-free product fileId",
    )
    .option("--replace-image-id <imageId>", "Resume at stage 3 with an image replace imageId")
    .option("--avatar-id <id>", "Stage 2: public product avatar id")
    .option("--template-image <path|url>", "Stage 2: your own avatar template image")
    .option("--generate-image-mode <mode>", "Stage 2: auto (default) or manual")
    .option("--image-edit-prompt <text>", "Stage 2: edit instruction (required in auto mode)")
    .option(
      "--location <json>",
      "Stage 2: product placement (manual mode), four [x,y] points, e.g. [[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]",
    )
    .option("--mode <mode>", `Stage 3 (required): ${PRODUCT_AVATAR_MODES.join(", ")}`)
    .option("--tts-text <text>", "Stage 3: script to speak (needs --voice-id)")
    .option("--voice-id <id>", "Stage 3: TTS voice id")
    .option(
      "--audio <path|url>",
      "Stage 3: speech audio (mp3, wav, m4a; avatar2 up to 28s, avatar4 up to 120s)",
    )
    .option("--caption-id <id>", "Stage 3: caption style id")
    .option(
      "--wait-timeout <ms>",
      "Polling timeout per stage in milliseconds",
      String(WAIT_TIMEOUT_MS),
    )
    .option("--download", "Download the final video (default)")
    .option("--no-download", "Print the final video URL instead of downloading")
    .option("--output <path>", "Output file path, or a directory")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: ProductAvatarOpts) => {
      await runProductAvatar(opts);
    });
}
