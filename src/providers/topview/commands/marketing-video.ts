/**
 * Avatar Marketing Video (legacy API, plan credits):
 * - `topview url-to-video`: a product page URL (TopView parses its media and copy);
 * - `topview materials-to-video`: uploaded images/videos plus a product name;
 * - `topview export`: export one script of a task submitted with --preview.
 * All three use the documented m2v endpoints (POST /v1/m2v/task/submit,
 * POST /v1/m2v/export, GET /v1/m2v/task/query).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { assertValidTaskId } from "../legacy-client.js";
import { createLegacyClientFromEnv, createTopviewLogger, resolveLegacyFile } from "./env.js";
import { compact, mergeExtra, oneOf } from "./json-input.js";
import { type TaskCliOpts, addTaskOptions, runLegacyTask } from "./task-runner.js";

const WAIT_MS = 1_800_000;
const ASPECT_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9"] as const;
const LANGUAGES = [
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
const VIDEO_LENGTHS = ["1", "2", "3", "4"] as const;

interface M2vFlags extends TaskCliOpts {
  productLink?: string;
  file?: string[];
  productName?: string;
  productDescription?: string;
  aspectRatio?: string;
  language?: string;
  avatarId?: string;
  voiceId?: string;
  captionId?: string;
  videoLength?: string;
  preview?: boolean;
  extra?: string;
}

function addM2vOptions(cmd: Command): Command {
  cmd
    .option("--product-name <name>", "Product name")
    .option("--product-description <text>", "Product description")
    .option("--aspect-ratio <ratio>", `Aspect ratio: ${ASPECT_RATIOS.join(", ")} (default 9:16)`)
    .option("--language <code>", "Script language code, e.g. en, vi, ja (default en)")
    .option("--avatar-id <id>", "AI avatar id (aiavatarId)")
    .option("--voice-id <id>", "Voice id")
    .option("--caption-id <id>", "Caption style id")
    .option("--video-length <n>", "1: 30-50s, 2: 15-30s, 3: 30-45s, 4: 45-60s (default 1)")
    .option("--preview", "Return preview videos first; export one with `topview export`")
    .option("--extra <json>", "More documented m2v fields as a JSON object or @file.json");
  return addTaskOptions(cmd, WAIT_MS);
}

/** The m2v body shared by both sources; the source fields are added by the caller. */
function m2vBody(opts: M2vFlags): Record<string, unknown> {
  const length = oneOf(opts.videoLength, VIDEO_LENGTHS, "--video-length");
  return compact({
    productName: opts.productName,
    productDescription: opts.productDescription,
    aspectRatio: oneOf(opts.aspectRatio, ASPECT_RATIOS, "--aspect-ratio"),
    language: oneOf(opts.language, LANGUAGES, "--language"),
    aiavatarId: opts.avatarId,
    voiceId: opts.voiceId,
    captionId: opts.captionId,
    videoLengthType: length === undefined ? undefined : Number(length),
    preview: opts.preview ? "true" : undefined,
  });
}

export function checkProductLink(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError("--product-link must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("--product-link must be an http(s) URL");
  }
  return url.toString();
}

async function runM2v(body: Record<string, unknown>, opts: M2vFlags): Promise<void> {
  const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
  const client = createLegacyClientFromEnv();
  const files = opts.file ?? [];
  const fileIds: string[] = [];
  for (const f of files) fileIds.push(await resolveLegacyFile(client, f, logger));
  await runLegacyTask({
    client,
    logger,
    kind: "m2v",
    body: mergeExtra(fileIds.length > 0 ? { ...body, fileIds } : body, opts.extra),
    opts,
    defaultWaitMs: WAIT_MS,
    hint: "video",
  });
}

export function registerMarketingVideoCommands(parent: Command): void {
  addM2vOptions(
    parent
      .command("url-to-video")
      .description("Avatar marketing video from a product page URL (legacy API, plan credits)")
      .requiredOption(
        "--product-link <url>",
        "Product page URL; TopView parses its media and copy",
      ),
  ).action(async (opts: M2vFlags) => {
    const productLink = checkProductLink(opts.productLink ?? "");
    await runM2v({ productLink, ...m2vBody(opts) }, opts);
  });

  addM2vOptions(
    parent
      .command("materials-to-video")
      .description("Avatar marketing video from your images/videos (legacy API, plan credits)")
      .option(
        "--file <pathOrAsset>",
        "Image or video: local file (uploaded) or asset:<fileId> (repeat for several)",
        (value: string, prev: string[]) => [...prev, value],
        [] as string[],
      ),
  ).action(async (opts: M2vFlags) => {
    if (!opts.file || opts.file.length === 0) {
      throw new ValidationError("Missing required option --file <pathOrAsset>");
    }
    if (!opts.productName?.trim()) {
      throw new ValidationError("--product-name is required without a product link");
    }
    await runM2v(m2vBody(opts), opts);
  });

  addTaskOptions(
    parent
      .command("export <taskId>")
      .description("Export one script of an m2v task submitted with --preview (legacy API)")
      .option("--script-id <id>", "Script id from the task's previewVideos"),
    WAIT_MS,
  ).action(async (taskId: string, opts: TaskCliOpts & { scriptId?: string }) => {
    assertValidTaskId(taskId);
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    await runLegacyTask({
      client: createLegacyClientFromEnv(),
      logger,
      kind: "m2v-export",
      body: compact({ taskId, scriptId: opts.scriptId }),
      opts,
      defaultWaitMs: WAIT_MS,
      hint: "video",
    });
  });
}
