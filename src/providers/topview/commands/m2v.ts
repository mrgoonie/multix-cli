/**
 * Avatar Marketing Video (Legacy API, POST /v1/m2v/task/submit):
 * - `topview url-to-video <product-url>`: TopView reads the product page (productLink).
 * - `topview materials-to-video --file <path|url>...`: uploaded images/videos (fileIds).
 * - `topview m2v-export <taskId> <scriptId>`: POST /v1/m2v/export renders a
 *   script of a `--preview` task as the final HD, watermark-free video
 *   ("5 points will be deducted after export is completed").
 *
 * Without `--preview` TopView returns the exported video directly, so no
 * export step is needed. Async by default; --wait polls and downloads.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { TopviewTaskError } from "../errors.js";
import { ASPECT_RATIOS, M2V_LANGUAGES, VIDEO_LENGTH_TYPES, assertLegacyId } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import { type PreparedFile, prepareFileInput, uploadPreparedFiles } from "../node-inputs.js";
import type { LegacyTask } from "../types.js";
import {
  type WaitFlagOptions,
  addWaitOptions,
  assertOneOf,
  assertWaitFlags,
  collect,
  completeLegacyTask,
  nonEmpty,
  parsePositiveInt,
  printLegacyHandle,
  reportLegacyOutputs,
  waitLegacyTask,
} from "./task-flow.js";

const URL_MAX_LENGTH = 2048;
const WAIT_TIMEOUT_MS = 1_800_000;

export interface M2vOpts extends WaitFlagOptions {
  file?: string[];
  productName?: string;
  productDescription?: string;
  aspectRatio?: string;
  language?: string;
  voiceId?: string;
  captionId?: string;
  avatarId?: string;
  videoLengthType?: string;
  logo?: string;
  music?: string;
  targetAudience?: string;
  preview?: boolean;
}

export interface M2vPlan {
  /** Body without the file ids that still need uploading. */
  body: Record<string, unknown>;
  files: PreparedFile[];
  logo?: PreparedFile;
  music?: PreparedFile;
}

/** Validate a product URL: http(s) only. It is sent as-is; TopView fetches it, not multix. */
export function checkProductUrl(raw: string): string {
  const value = raw.trim();
  if (value.length > URL_MAX_LENGTH) {
    throw new ValidationError(`<product-url> is longer than ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("<product-url> is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("<product-url> must be an http:// or https:// URL");
  }
  if (url.username || url.password) {
    throw new ValidationError("<product-url> must not contain a username or password");
  }
  return value;
}

/** Validate every flag before any upload or paid request. */
export function planM2v(
  source: { productLink: string } | { files: string[] },
  opts: M2vOpts,
): M2vPlan {
  const body: Record<string, unknown> = {};
  const productName = nonEmpty(opts.productName, "--product-name", 500);
  const productDescription = nonEmpty(opts.productDescription, "--product-description");
  let files: PreparedFile[] = [];
  if ("productLink" in source) {
    body.productLink = checkProductUrl(source.productLink);
  } else {
    if (source.files.length === 0) {
      throw new ValidationError("materials-to-video needs at least one --file <path|url>");
    }
    // Without a product link TopView needs the name and the description (no DIY script here).
    if (!productName || !productDescription) {
      throw new ValidationError(
        "materials-to-video needs --product-name and --product-description (TopView requires them without a product URL)",
      );
    }
    files = source.files.map((f) => prepareFileInput(f, "--file", ["image", "video"]));
  }
  if (productName) body.productName = productName;
  if (productDescription) body.productDescription = productDescription;
  if (opts.aspectRatio !== undefined) {
    body.aspectRatio = assertOneOf(opts.aspectRatio, ASPECT_RATIOS, "--aspect-ratio");
  }
  if (opts.language !== undefined) {
    body.language = assertOneOf(opts.language, M2V_LANGUAGES, "--language");
  }
  const voiceId = nonEmpty(opts.voiceId, "--voice-id", 128);
  if (voiceId) body.voiceId = voiceId;
  const captionId = nonEmpty(opts.captionId, "--caption-id", 128);
  if (captionId) body.captionId = captionId;
  const avatarId = nonEmpty(opts.avatarId, "--avatar-id", 128);
  if (avatarId) body.aiavatarId = avatarId;
  if (opts.videoLengthType !== undefined) {
    body.videoLengthType = Number(
      assertOneOf(opts.videoLengthType, VIDEO_LENGTH_TYPES, "--video-length-type"),
    );
  }
  const audience = nonEmpty(opts.targetAudience, "--target-audience", 1000);
  if (audience) body.targetAudience = audience;
  // The API types `preview` as a string.
  if (opts.preview) body.preview = "true";
  return {
    body,
    files,
    ...(opts.logo !== undefined ? { logo: prepareFileInput(opts.logo, "--logo", ["image"]) } : {}),
    ...(opts.music !== undefined
      ? { music: prepareFileInput(opts.music, "--music", ["audio"]) }
      : {}),
  };
}

function addM2vOptions(cmd: Command): Command {
  return cmd
    .option("--product-name <name>", "Product name (required without a product URL)")
    .option("--product-description <text>", "Product description (required without a product URL)")
    .option("--aspect-ratio <ratio>", `Aspect ratio: ${ASPECT_RATIOS.join(", ")} (default 9:16)`)
    .option("--language <code>", "Script language code, e.g. en, vi, ja (default en)")
    .option("--voice-id <id>", "Voice id (GET /v1/voice/query)")
    .option("--caption-id <id>", "Caption style id (random when omitted)")
    .option("--avatar-id <id>", "AI avatar id (aiavatarId)")
    .option("--video-length-type <n>", "1 = 30-50s (default), 2 = 15-30s, 3 = 30-45s, 4 = 45-60s")
    .option("--logo <path|url>", "Logo image (png, jpg, jpeg, bmp, webp)")
    .option("--music <path|url>", "Background music (mp3, wav, m4a; random when omitted)")
    .option("--target-audience <text>", "Target audience description")
    .option("--preview", "Return preview videos first; export one later with m2v-export");
}

async function runM2v(source: { productLink: string } | { files: string[] }, opts: M2vOpts) {
  const logger = createLogger({ verbose: opts.verbose ?? false });
  assertWaitFlags(opts, "multix topview status m2v <taskId> --wait --download");
  const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
  const plan = planM2v(source, opts);
  const client = createTopviewLegacyClient();

  const body = { ...plan.body };
  if (plan.files.length > 0) body.fileIds = await uploadPreparedFiles(client, plan.files, logger);
  if (plan.logo) [body.logoFileId] = await uploadPreparedFiles(client, [plan.logo], logger);
  if (plan.music) [body.musicFileId] = await uploadPreparedFiles(client, [plan.music], logger);

  const what =
    "productLink" in source
      ? `URL-to-video (${new URL(source.productLink).hostname})`
      : `materials-to-video (${plan.files.length} file(s))`;
  logger.info(`TopView ${what}${opts.preview ? ", preview first" : ""}`);
  const submitted = await client.submitM2v(body);
  logger.success(`Created TopView m2v task ${submitted.taskId}`);
  if (opts.preview) {
    logger.info(
      `Preview mode: once previews are ready, export one with: multix topview m2v-export ${submitted.taskId} <scriptId> (5 credits after the export completes)`,
    );
  }
  if (!opts.wait) {
    printLegacyHandle("m2v", submitted.taskId);
    return;
  }
  await completeLegacyTask(client, "m2v", submitted.taskId, {
    waitTimeoutMs,
    logger,
    download: opts.download !== false,
    rawUrls: opts.download === false,
    output: opts.output,
  });
}

export function registerTopviewM2vCommands(parent: Command): void {
  const urlCmd = parent
    .command("url-to-video <product-url>")
    .description(
      "Legacy API: marketing video from a product page URL (m2v); prints a task id unless --wait",
    );
  addWaitOptions(addM2vOptions(urlCmd), WAIT_TIMEOUT_MS).action(
    (productUrl: string, opts: M2vOpts) => runM2v({ productLink: productUrl }, opts),
  );

  const filesCmd = parent
    .command("materials-to-video")
    .description(
      "Legacy API: marketing video from uploaded images/videos (m2v); prints a task id unless --wait",
    )
    .option(
      "--file <path|url>",
      "Product image or video (png, jpg, jpeg, bmp, webp, mp4, avi, mov); repeatable",
      collect,
    );
  addWaitOptions(addM2vOptions(filesCmd), WAIT_TIMEOUT_MS).action((opts: M2vOpts) =>
    runM2v({ files: opts.file ?? [] }, opts),
  );

  const exportCmd = parent
    .command("m2v-export <taskId> <scriptId>")
    .description(
      "Legacy API: export one script of a --preview m2v task as the final video (billed once exported)",
    );
  addWaitOptions(exportCmd, WAIT_TIMEOUT_MS).action(
    async (taskId: string, scriptIdRaw: string, opts: WaitFlagOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      assertWaitFlags(opts, "multix topview status m2v <taskId> --wait --download");
      const id = assertLegacyId(taskId);
      const scriptId = Number(scriptIdRaw);
      if (!/^\d+$/.test(scriptIdRaw.trim()) || !Number.isSafeInteger(scriptId)) {
        throw new ValidationError("<scriptId> must be a whole number (see `topview status m2v`)");
      }
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const client = createTopviewLegacyClient();
      const submitted = await client.exportM2v(id, scriptId);
      logger.success(
        `Export of script ${scriptId} submitted for TopView m2v task ${submitted.taskId}`,
      );
      if (!opts.wait) {
        printLegacyHandle("m2v", submitted.taskId);
        return;
      }
      const exportOf = (t: LegacyTask) =>
        (t.videos ?? []).find((v) => v.type === "export" && v.scriptId === scriptId);
      const final = await waitLegacyTask(client, "m2v", submitted.taskId, {
        waitTimeoutMs,
        logger,
        // The task itself stays "success" from the preview; wait for this export.
        isDone: (t) =>
          t.status === "fail" || ["success", "fail"].includes(exportOf(t)?.status ?? ""),
      });
      if (exportOf(final)?.status === "fail") {
        throw new TopviewTaskError(final, `: export of script ${scriptId} failed`);
      }
      await reportLegacyOutputs(final, {
        labels: [`export-${scriptId}`],
        logger,
        download: opts.download !== false,
        rawUrls: opts.download === false,
        output: opts.output,
      });
    },
  );
}
