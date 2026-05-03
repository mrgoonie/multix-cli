/**
 * Resolve an image input (URL or local path) to a form usable in BytePlus
 * `image_url` content items. URLs pass through; local files are read and
 * encoded as `data:<mime>;base64,...`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../core/logger.js";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

const SOFT_LIMIT_BYTES = 10 * 1024 * 1024;
const HARD_LIMIT_BYTES = 25 * 1024 * 1024;

export type ResolvedImage =
  | { kind: "url"; url: string }
  | { kind: "data"; dataUrl: string; mime: string; bytes: number };

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

async function readAsDataUrl(
  filePath: string,
  mimeTable: Record<string, string>,
  kindLabel: string,
  logger?: Logger,
): Promise<{ dataUrl: string; mime: string; bytes: number }> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeTable[ext];
  if (!mime) {
    throw new Error(
      `Unsupported ${kindLabel} extension '${ext}'. Allowed: ${Object.keys(mimeTable).join(", ")}`,
    );
  }
  const buf = await fs.readFile(filePath);
  if (buf.byteLength > HARD_LIMIT_BYTES) {
    throw new Error(
      `${kindLabel} file ${filePath} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — exceeds ${HARD_LIMIT_BYTES / 1024 / 1024}MB limit. Upload to a URL instead.`,
    );
  }
  if (buf.byteLength > SOFT_LIMIT_BYTES) {
    logger?.warn(
      `${kindLabel} payload ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB is large; consider URL input.`,
    );
  }
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  return { dataUrl, mime, bytes: buf.byteLength };
}

export async function resolveImageInput(input: string, logger?: Logger): Promise<ResolvedImage> {
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, IMAGE_MIME_BY_EXT, "image", logger);
  return { kind: "data", dataUrl, mime, bytes };
}

export async function resolveVideoInput(input: string, logger?: Logger): Promise<ResolvedImage> {
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, VIDEO_MIME_BY_EXT, "video", logger);
  return { kind: "data", dataUrl, mime, bytes };
}

export async function resolveAudioInput(input: string, logger?: Logger): Promise<ResolvedImage> {
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, AUDIO_MIME_BY_EXT, "audio", logger);
  return { kind: "data", dataUrl, mime, bytes };
}

/** Get the URL or data URL string from a ResolvedImage. */
export function refUrl(r: ResolvedImage): string {
  return r.kind === "url" ? r.url : r.dataUrl;
}
