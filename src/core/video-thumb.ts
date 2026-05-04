/**
 * Generic thumbnail/cover detection for provider video responses.
 *
 * Walks an arbitrary object looking for a small set of well-known field names
 * (cover_image_url, thumbnail_url, etc.) whose value is an http(s) URL pointing
 * to an image. Used by all video commands so a generated video's thumbnail is
 * downloaded next to the .mp4 when the provider exposes one.
 */

import fs from "node:fs";
import path from "node:path";
import { downloadFile } from "./http-client.js";
import type { Logger } from "./logger.js";

const THUMB_KEYS = new Set([
  "cover_image_url",
  "coverImageUrl",
  "cover_url",
  "coverUrl",
  "thumbnail_url",
  "thumbnailUrl",
  "thumb_url",
  "thumbUrl",
  "preview_url",
  "previewUrl",
  "first_frame_url",
  "firstFrameUrl",
  "poster_url",
  "posterUrl",
  "image_url",
  "imageUrl",
]);

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;

function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return IMAGE_EXT_RE.test(value);
}

/**
 * Recursively walk `obj` for the first known thumbnail field whose value is a
 * plausible image URL. Returns the URL string or null.
 */
export function detectThumbUrl(obj: unknown): string | null {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = detectThumbUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (THUMB_KEYS.has(key) && isImageUrl(value)) return value;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = detectThumbUrl(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Derive a `<base>_thumb.<ext>` path next to `videoPath` and download `thumbUrl`.
 * Extension comes from the URL when recognizable, otherwise falls back to .jpg.
 * Returns the saved path on success, null on failure (logged as warn).
 */
export async function downloadThumbBeside(
  thumbUrl: string,
  videoPath: string,
  logger?: Logger,
): Promise<string | null> {
  const match = thumbUrl.match(IMAGE_EXT_RE);
  const ext = match?.[1] ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const dest = path.join(dir, `${base}_thumb.${ext}`);
  try {
    await downloadFile(thumbUrl, dest);
    logger?.success(`Saved thumb ${dest}`);
    return dest;
  } catch (e) {
    logger?.warn(`Thumb download failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Convenience: detect and download in one call. Honors `skip` (e.g. --no-thumb).
 * Also copies the thumb next to a user-supplied --output path when given.
 */
export async function maybeDownloadThumb(
  source: unknown,
  videoPath: string,
  opts: { skip?: boolean; copyTo?: string; logger?: Logger } = {},
): Promise<string | null> {
  if (opts.skip) return null;
  const url = detectThumbUrl(source);
  if (!url) {
    opts.logger?.debug("No thumbnail URL detected in provider response");
    return null;
  }
  const saved = await downloadThumbBeside(url, videoPath, opts.logger);
  if (saved && opts.copyTo) {
    const copyExt = path.extname(saved);
    const copyBase = path.basename(opts.copyTo, path.extname(opts.copyTo));
    const copyDir = path.dirname(path.resolve(opts.copyTo));
    const copyDest = path.join(copyDir, `${copyBase}_thumb${copyExt}`);
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(saved, copyDest);
    opts.logger?.success(`Copied thumb to ${copyDest}`);
  }
  return saved;
}
