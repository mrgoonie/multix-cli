/**
 * Node-only: turn file flags into what TopView accepts.
 *
 * - Legacy API inputs are fileIds. An existing local path is uploaded
 *   (credential, PUT, check) and its fileId returned; otherwise a value shaped
 *   like a fileId is passed through as an earlier upload.
 * - API Platform inputs are public URLs. An http(s) URL is checked (public
 *   address only) and passed through; a local image is uploaded to
 *   /media/files and its signed download URL used.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { TopviewClient } from "./client.js";
import { UPLOAD_FORMATS, assertPublicHttpUrl, isLegacyId, uploadFormatOf } from "./models.js";
import { MEDIA_MAX_BYTES, type TopviewPlatformClient } from "./platform-client.js";

type MediaKind = keyof typeof UPLOAD_FORMATS;

function statFile(value: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(path.resolve(value));
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** True when `value` names an existing local file. */
export function isLocalFile(value: string): boolean {
  return statFile(value.trim()) !== undefined;
}

/**
 * Resolve a legacy file flag to a fileId: upload a local file, or accept a
 * fileId from an earlier `multix topview upload`. `kinds` limits the formats.
 */
export async function resolveLegacyFile(
  value: string,
  flag: string,
  client: TopviewClient,
  logger: Logger,
  kinds: readonly MediaKind[] = ["image", "audio", "video"],
): Promise<string> {
  precheckLegacyFile(value, flag, kinds);
  const trimmed = value.trim();
  const stat = statFile(trimmed);
  if (!stat) return trimmed;
  const format = checkLegacyFormat(trimmed, flag, kinds);
  const name = path.basename(trimmed);
  logger.info(`Uploading ${name} (${formatMb(stat.size)}) to TopView...`);
  const bytes = fs.readFileSync(path.resolve(trimmed));
  const fileId = await client.uploadFile({ data: new Blob([bytes]), format, name });
  logger.debug(`Uploaded ${name} as fileId ${fileId}`);
  return fileId;
}

/** The upload format of a local file, limited to `kinds`. */
export function checkLegacyFormat(file: string, flag: string, kinds: readonly MediaKind[]): string {
  const format = uploadFormatOf(path.extname(file));
  const allowed: string[] = kinds.flatMap((k) => [...UPLOAD_FORMATS[k]]);
  if (!format || !allowed.includes(format)) {
    throw new ValidationError(
      `${flag} must be one of: ${allowed.join(", ")} (got ${path.basename(file)})`,
    );
  }
  return format;
}

/** Check a legacy file flag without uploading: a local file of the right format, or a fileId. */
export function precheckLegacyFile(
  value: string,
  flag: string,
  kinds: readonly MediaKind[] = ["image", "audio", "video"],
): void {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${flag} must not be empty`);
  if (statFile(trimmed)) {
    checkLegacyFormat(trimmed, flag, kinds);
    return;
  }
  if (isLegacyId(trimmed) && !/\.[A-Za-z0-9]{2,4}$/.test(trimmed)) return;
  throw new ValidationError(
    `${flag}: file not found: ${trimmed} (pass a local file or a fileId from \`multix topview upload\`)`,
  );
}

const PLATFORM_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** Check a platform --image value without uploading: a public URL or a local PNG/JPEG/WebP up to 20 MiB. */
export function precheckPlatformImage(value: string, flag: string): void {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    assertPublicHttpUrl(trimmed, flag);
    return;
  }
  const stat = statFile(trimmed);
  if (!stat)
    throw new ValidationError(
      `${flag}: file not found: ${trimmed} (pass a local image or a public URL)`,
    );
  if (!PLATFORM_IMAGE_TYPES[path.extname(trimmed).toLowerCase()]) {
    throw new ValidationError(`${flag} must be a .png, .jpg, .jpeg or .webp image`);
  }
  if (stat.size > MEDIA_MAX_BYTES) {
    throw new ValidationError(
      `${flag} is ${formatMb(stat.size)}; the API Platform accepts at most 20 MiB`,
    );
  }
}

/** Resolve a platform --image value to a URL, uploading a local file first. */
export async function resolvePlatformImage(
  value: string,
  flag: string,
  client: TopviewPlatformClient,
  logger: Logger,
): Promise<string> {
  precheckPlatformImage(value, flag);
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const name = path.basename(trimmed);
  const type = PLATFORM_IMAGE_TYPES[path.extname(trimmed).toLowerCase()] as string;
  logger.info(`Uploading ${name} to the TopView API Platform...`);
  const asset = await client.uploadMedia({
    data: new Blob([fs.readFileSync(path.resolve(trimmed))], { type }),
    filename: name,
    kind: "image",
  });
  logger.debug(`Uploaded ${name} as media ${asset.id}`);
  return asset.downloadUrl;
}
