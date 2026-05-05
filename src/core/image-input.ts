/**
 * Resolve a media input (URL or local path) to a form usable in provider
 * `image_url` / multimodal content items. URLs pass through; local files are
 * read and encoded as `data:<mime>;base64,...`.
 *
 * Size limits are configurable per-provider — pass via `opts` to override
 * defaults (10MB soft warn, 25MB hard error).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";

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

const DEFAULT_SOFT_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_HARD_LIMIT_BYTES = 25 * 1024 * 1024;

export type ResolvedImage =
  | { kind: "url"; url: string }
  | { kind: "data"; dataUrl: string; mime: string; bytes: number };

export interface ResolveOptions {
  logger?: Logger;
  /** Soft warn threshold in bytes. Default 10MB. */
  softLimitBytes?: number;
  /** Hard error threshold in bytes. Default 25MB. */
  hardLimitBytes?: number;
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

async function readAsDataUrl(
  filePath: string,
  mimeTable: Record<string, string>,
  kindLabel: string,
  opts: ResolveOptions = {},
): Promise<{ dataUrl: string; mime: string; bytes: number }> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeTable[ext];
  if (!mime) {
    throw new Error(
      `Unsupported ${kindLabel} extension '${ext}'. Allowed: ${Object.keys(mimeTable).join(", ")}`,
    );
  }
  const hard = opts.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES;
  const soft = opts.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES;
  const buf = await fs.readFile(filePath);
  if (buf.byteLength > hard) {
    throw new Error(
      `${kindLabel} file ${filePath} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — exceeds ${(hard / 1024 / 1024).toFixed(0)}MB limit. Upload to a URL instead.`,
    );
  }
  if (buf.byteLength > soft) {
    opts.logger?.warn(
      `${kindLabel} payload ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB is large; consider URL input.`,
    );
  }
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  return { dataUrl, mime, bytes: buf.byteLength };
}

export async function resolveImageInput(
  input: string,
  opts: ResolveOptions | Logger = {},
): Promise<ResolvedImage> {
  const o = normalizeOpts(opts);
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, IMAGE_MIME_BY_EXT, "image", o);
  return { kind: "data", dataUrl, mime, bytes };
}

export async function resolveVideoInput(
  input: string,
  opts: ResolveOptions | Logger = {},
): Promise<ResolvedImage> {
  const o = normalizeOpts(opts);
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, VIDEO_MIME_BY_EXT, "video", o);
  return { kind: "data", dataUrl, mime, bytes };
}

export async function resolveAudioInput(
  input: string,
  opts: ResolveOptions | Logger = {},
): Promise<ResolvedImage> {
  const o = normalizeOpts(opts);
  if (isHttpUrl(input)) return { kind: "url", url: input };
  const { dataUrl, mime, bytes } = await readAsDataUrl(input, AUDIO_MIME_BY_EXT, "audio", o);
  return { kind: "data", dataUrl, mime, bytes };
}

/** Get the URL or data URL string from a ResolvedImage. */
export function refUrl(r: ResolvedImage): string {
  return r.kind === "url" ? r.url : r.dataUrl;
}

/** Get raw bytes count (0 for URL refs). */
export function refBytes(r: ResolvedImage): number {
  return r.kind === "data" ? r.bytes : 0;
}

// Backwards-compat: original signature accepted `logger?: Logger` directly.
function normalizeOpts(opts: ResolveOptions | Logger | undefined): ResolveOptions {
  if (!opts) return {};
  if (typeof (opts as Logger).info === "function" && typeof (opts as Logger).warn === "function") {
    return { logger: opts as Logger };
  }
  return opts as ResolveOptions;
}
