/**
 * Node-only: turn `--image` / `--reference` values into URIs the Runway API accepts.
 *
 * - https URLs pass through after a local check (https only, a domain rather
 *   than an IP literal or localhost, at most 2048 characters). Runway fetches
 *   them itself and does not follow redirects.
 * - `runway://` URIs (earlier uploads) and `data:image/...` URIs pass through.
 * - Local JPEG/PNG/WebP files become a data URI when the encoded form fits in
 *   5MB, otherwise they are uploaded (ephemeral, valid 24h) up to 200MB.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { isNonPublicHost } from "../../core/url-safety.js";
import type { RunwayClient } from "./client.js";

export const DATA_URI_MAX_CHARS = 5 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const UPLOAD_MIN_BYTES = 512;
export const URL_MAX_LENGTH = 2048;

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const DATA_IMAGE_RE = /^data:image\/(jpeg|jpg|png|webp)[;,]/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function checkRemoteUrl(value: string, flag: string): string {
  if (value.length > URL_MAX_LENGTH) {
    throw new ValidationError(`${flag} URL is longer than ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${flag} is not a valid URL`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:") {
    throw new ValidationError(`${flag} URL must use https:// (Runway rejects other schemes)`);
  }
  if (IPV4_RE.test(host) || host.startsWith("[") || host.includes(":") || isNonPublicHost(host)) {
    throw new ValidationError(
      `${flag} URL must use a public domain name, not an IP address or local host (${host})`,
    );
  }
  return value;
}

/** Resolve one image value (path, https URL, data URI or runway:// URI) into a request URI. */
export async function resolveImageInput(
  value: string,
  flag: string,
  client: RunwayClient,
  logger: Logger,
): Promise<string> {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return checkRemoteUrl(trimmed, flag);
  if (/^runway:\/\//i.test(trimmed)) return trimmed;
  if (/^data:/i.test(trimmed)) {
    if (!DATA_IMAGE_RE.test(trimmed)) {
      throw new ValidationError(`${flag} data URI must be a JPEG, PNG or WebP image`);
    }
    if (trimmed.length > DATA_URI_MAX_CHARS) {
      throw new ValidationError(`${flag} data URI is larger than Runway's 5MB limit`);
    }
    return trimmed;
  }

  const filePath = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ValidationError(
      `${flag} file not found: ${value} (pass a local path or an https URL)`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`${flag} path is not a file: ${value}`);
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new ValidationError(`${flag} must be a .jpg, .jpeg, .png or .webp image (got ${value})`);
  }
  if (stat.size >= UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `${flag} file ${value} is ${formatMb(stat.size)}; Runway accepts images under 200MB`,
    );
  }

  const filename = path.basename(filePath);
  const bytes = fs.readFileSync(filePath);
  const prefix = `data:${mime};base64,`;
  if (prefix.length + Math.ceil(bytes.length / 3) * 4 <= DATA_URI_MAX_CHARS) {
    logger.debug(`Inlining ${filename} (${bytes.length} bytes) as a data URI`);
    return `${prefix}${bytes.toString("base64")}`;
  }
  if (bytes.length < UPLOAD_MIN_BYTES) {
    throw new ValidationError(`${flag} file ${value} is too small to upload`);
  }
  logger.info(`Uploading ${filename} (${formatMb(bytes.length)}) to Runway...`);
  const uri = await client.uploadEphemeral({
    data: new Blob([bytes], { type: mime }),
    filename,
  });
  logger.debug(`Uploaded ${filename}`);
  return uri;
}
