/**
 * Avatar marketing video ("m2v") commands on the legacy API (credits):
 * - `topview url-to-video <productUrl>`: from a product page
 * - `topview materials-to-video --file <path|fileId>...`: from images/videos
 * - `topview export <taskId>`: render the final video of a script
 *
 * All use the documented POST /v1/m2v/task/submit and /v1/m2v/export
 * (https://docs.topview.ai/reference/avatar_marketing_video_submit_task), not
 * the undocumented /v1/url2video or /v1/materials2video paths from the
 * marketing page. TopView offers no cancel for these tasks.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { type TopviewClient, exportsOf } from "../client.js";
import { assertLegacyId, assertPublicHttpUrl, isLegacyTerminal } from "../models.js";
import { createTopviewClient } from "../node-client.js";
import { precheckLegacyFile, resolveLegacyFile } from "../node-inputs.js";
import type { M2vSubmitRequest } from "../types.js";
import {
  type WaitFlagOptions,
  addOutputOptions,
  checkWaitFlags,
  completeLegacyTask,
  parsePositiveInt,
  printTaskHandle,
} from "./task-flow.js";

export const M2V_ASPECT_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9"] as const;
export const M2V_LANGUAGES = [
  "en",
  "ar",
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "fil",
  "fi",
  "fr",
  "de",
  "el",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nb",
  "pl",
  "pt",
  "ro",
  "ru",
  "zh-CN",
  "sk",
  "es",
  "sv",
  "zh-Hant",
  "tr",
  "uk",
  "vi",
  "th",
] as const;
const ENDCARD_RATIOS = ["all", ...M2V_ASPECT_RATIOS] as const;
const TEXT_MAX = 5000;
/** m2v renders can take a while; the docs give no duration. */
const M2V_TIMEOUT_MS = 1_800_000;

export interface M2vOpts extends WaitFlagOptions {
  file?: string[];
  productName?: string;
  productDescription?: string;
  aspectRatio?: string;
  language?: string;
  voiceId?: string;
  captionId?: string;
  avatarId?: string;
  videoLength?: string;
  endcard?: string;
  endcardAspectRatio?: string;
  endcardBackground?: string;
  logo?: string;
  music?: string;
  preview?: boolean;
  scriptStyle?: string;
  scriptPrompt?: string;
  targetAudience?: string;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

function oneOf(value: string | undefined, allowed: readonly string[], flag: string) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new ValidationError(`${flag} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function text(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${flag} must not be empty`);
  if (trimmed.length > TEXT_MAX)
    throw new ValidationError(`${flag} is longer than ${TEXT_MAX} characters`);
  return trimmed;
}

function id(value: string | undefined, what: string): string | undefined {
  return value === undefined ? undefined : assertLegacyId(value, what);
}

/** Register the options shared by url-to-video and materials-to-video. */
function addM2vOptions(cmd: Command): Command {
  return cmd
    .option("--product-name <name>", "Product name")
    .option("--product-description <text>", "Product description")
    .option(
      "--aspect-ratio <ratio>",
      `Aspect ratio: ${M2V_ASPECT_RATIOS.join(", ")} (default 9:16)`,
    )
    .option("--language <code>", "Script language code, e.g. en, vi, ja (default en)")
    .option("--voice-id <id>", "Voice id (TopView voice list)")
    .option("--caption-id <id>", "Caption style id (TopView caption list)")
    .option("--avatar-id <id>", "AI avatar id (TopView aiAvatar list)")
    .option("--video-length <1-4>", "1: 30-50s, 2: 15-30s, 3: 30-45s, 4: 45-60s (default 1)")
    .option("--endcard <path|fileId>", "End card image")
    .option("--endcard-aspect-ratio <ratio>", `End card ratio: ${ENDCARD_RATIOS.join(", ")}`)
    .option("--endcard-background <color>", "End card background: black or white")
    .option("--logo <path|fileId>", "Logo image")
    .option("--music <path|fileId>", "Background music")
    .option("--preview", "Generate previews only (export later with `topview export`)")
    .option(
      "--script-style <style>",
      'Preset script style, e.g. "Auto-select by AI" or "Storytelling style"',
    )
    .option("--script-prompt <prompt>", "Your own script instructions (instead of --script-style)")
    .option("--target-audience <text>", "Target audience, to guide the script");
}

/** Validate every flag and build the request without file ids (uploads come later). */
export function planM2v(
  opts: M2vOpts,
  source: { productLink: string } | { files: string[] },
): M2vSubmitRequest {
  if (opts.scriptStyle !== undefined && opts.scriptPrompt !== undefined) {
    throw new ValidationError("Use either --script-style or --script-prompt, not both");
  }
  const diy = opts.scriptStyle !== undefined || opts.scriptPrompt !== undefined;
  const request: M2vSubmitRequest = {};
  if ("productLink" in source) {
    request.productLink = assertPublicHttpUrl(source.productLink, "productUrl");
  } else {
    if (source.files.length === 0)
      throw new ValidationError("Pass at least one --file <path|fileId>");
    for (const f of source.files) precheckLegacyFile(f, "--file", ["image", "video"]);
    if (opts.productName === undefined) {
      throw new ValidationError("--product-name is required without a product URL");
    }
    if (opts.productDescription === undefined && !diy) {
      throw new ValidationError(
        "--product-description is required without a product URL (unless you pass --script-style or --script-prompt)",
      );
    }
  }
  const set = <K extends keyof M2vSubmitRequest>(
    key: K,
    value: M2vSubmitRequest[K] | undefined,
  ) => {
    if (value !== undefined) request[key] = value;
  };
  set("productName", text(opts.productName, "--product-name"));
  set("productDescription", text(opts.productDescription, "--product-description"));
  set("aspectRatio", oneOf(opts.aspectRatio, M2V_ASPECT_RATIOS, "--aspect-ratio"));
  set("language", oneOf(opts.language, M2V_LANGUAGES, "--language"));
  set("voiceId", id(opts.voiceId, "voice id"));
  set("captionId", id(opts.captionId, "caption id"));
  set("aiavatarId", id(opts.avatarId, "avatar id"));
  if (opts.videoLength !== undefined) {
    set("videoLengthType", parsePositiveInt(opts.videoLength, "--video-length", 4));
  }
  set(
    "endcardAspectRatio",
    oneOf(opts.endcardAspectRatio, ENDCARD_RATIOS, "--endcard-aspect-ratio"),
  );
  set(
    "endcardBackgroundColor",
    oneOf(opts.endcardBackground, ["black", "white"], "--endcard-background"),
  );
  if (opts.preview) request.preview = "true";
  if (diy) {
    request.isDiyScript = "true";
    if (opts.scriptStyle !== undefined) {
      request.diyStyle = "diyScriptStyle";
      request.diyScriptStyle = text(opts.scriptStyle, "--script-style");
    } else {
      request.diyStyle = "diyScriptPrompt";
      request.diyScriptPrompt = text(opts.scriptPrompt, "--script-prompt");
    }
  }
  set("targetAudience", text(opts.targetAudience, "--target-audience"));
  if (opts.endcard !== undefined) precheckLegacyFile(opts.endcard, "--endcard", ["image"]);
  if (opts.logo !== undefined) precheckLegacyFile(opts.logo, "--logo", ["image"]);
  if (opts.music !== undefined) precheckLegacyFile(opts.music, "--music", ["audio"]);
  return request;
}

async function runM2v(
  opts: M2vOpts,
  source: { productLink: string } | { files: string[] },
): Promise<void> {
  const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
  const waitTimeoutMs = checkWaitFlags(opts, "m2v");
  const request = planM2v(opts, source);
  const client: TopviewClient = createTopviewClient();

  if ("files" in source) {
    request.fileIds = [];
    for (const f of source.files) {
      request.fileIds.push(
        await resolveLegacyFile(f, "--file", client, logger, ["image", "video"]),
      );
    }
  }
  if (opts.endcard !== undefined) {
    request.endcardFileId = await resolveLegacyFile(opts.endcard, "--endcard", client, logger, [
      "image",
    ]);
  }
  if (opts.logo !== undefined) {
    request.logoFileId = await resolveLegacyFile(opts.logo, "--logo", client, logger, ["image"]);
  }
  if (opts.music !== undefined) {
    request.musicFileId = await resolveLegacyFile(opts.music, "--music", client, logger, ["audio"]);
  }

  logger.info("Billed in TopView credits: 5 credits once the video is exported");
  const submitted = await client.submitM2v(request);
  logger.success(`Created TopView m2v task ${submitted.taskId}`);
  if (!opts.wait) {
    printTaskHandle("m2v", submitted.taskId);
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

interface ExportOpts extends WaitFlagOptions {
  scriptId?: string;
}

export function registerMarketingCommands(parent: Command): void {
  const url = addM2vOptions(
    parent
      .command("url-to-video <productUrl>")
      .description("Avatar marketing video from a product page URL (legacy API, credits)"),
  );
  addOutputOptions(url, M2V_TIMEOUT_MS).action((productUrl: string, opts: M2vOpts) =>
    runM2v(opts, { productLink: productUrl }),
  );

  const materials = addM2vOptions(
    parent
      .command("materials-to-video")
      .description("Avatar marketing video from product images/videos (legacy API, credits)")
      .option("--file <path|fileId>", "Product image or video (repeatable)", collect, []),
  );
  addOutputOptions(materials, M2V_TIMEOUT_MS).action((opts: M2vOpts) =>
    runM2v(opts, { files: opts.file ?? [] }),
  );

  const exp = parent
    .command("export <taskId>")
    .description("Export the final video of an m2v task (5 credits once exported)")
    .option("--script-id <id>", "Script to export (see previewVideos[].scriptId)");
  addOutputOptions(exp, M2V_TIMEOUT_MS).action(async (taskId: string, opts: ExportOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
    const waitTimeoutMs = checkWaitFlags(opts, "m2v");
    const id = assertLegacyId(taskId);
    const scriptId =
      opts.scriptId !== undefined ? assertLegacyId(opts.scriptId, "script id") : undefined;
    const client = createTopviewClient();
    const submitted = await client.exportM2v(id, scriptId);
    logger.success(`Export requested for m2v task ${submitted.taskId}`);
    if (!opts.wait) {
      printTaskHandle("m2v", submitted.taskId);
      return;
    }
    const exported = (t: Parameters<typeof exportsOf>[0]) =>
      exportsOf(t, scriptId).filter((v) => v.status === "success" && v.videoUrl);
    await completeLegacyTask(client, "m2v", submitted.taskId, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
      // Done once the task failed, or the export of this script finished.
      isDone: (t) =>
        t.status === "fail" ||
        (exportsOf(t, scriptId).length > 0 &&
          exportsOf(t, scriptId).every((v) => isLegacyTerminal(v.status))),
      judge: (t) =>
        exported(t).length > 0
          ? { ...t, status: "success" }
          : { ...t, status: "fail", errorMsg: t.errorMsg ?? "the export finished without a video" },
      outputs: (t) => exported(t).map((v) => v.videoUrl as string),
    });
  });
}
