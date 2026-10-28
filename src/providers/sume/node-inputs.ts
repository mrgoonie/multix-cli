/**
 * Node-only: turn media options (`--image`, `--video`, `--audio`, ...) into
 * the public https URLs Sume's routers accept.
 *
 * - https URLs pass through after a local check (https only, a public domain
 *   rather than an IP literal or localhost, at most 2048 characters, no
 *   credentials). Sume fetches them itself and refuses private addresses too.
 * - Local files are uploaded through `generate-upload-url` (no charge), and
 *   their public `media.sume.com` URL is used instead. The signed upload URL
 *   is never logged.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { isNonPublicHost } from "../../core/url-safety.js";
import type { SumeClient } from "./client.js";
import type { MediaInput } from "./request.js";

/** Sume signs uploads up to 2 GiB. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const URL_MAX_LENGTH = 2048;

export type MediaKind = "image" | "video" | "audio";

const MIME: Record<MediaKind, Record<string, string>> = {
  image: {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  },
  video: {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  },
  audio: {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
  },
};

/** The kind of media each request field carries. */
const FIELD_KIND: Record<string, MediaKind> = {
  image_urls: "image",
  image_url: "image",
  end_image_url: "image",
  reference_image_urls: "image",
  video_url: "video",
  audio_url: "audio",
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Check an https media URL before Sume is asked to fetch it. */
export function checkRemoteUrl(value: string, flag: string): string {
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
    throw new ValidationError(`${flag} URL must use https:// (Sume refuses other schemes)`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${flag} URL must not contain a username or password`);
  }
  if (IPV4_RE.test(host) || host.startsWith("[") || host.includes(":") || isNonPublicHost(host)) {
    throw new ValidationError(
      `${flag} URL must use a public domain name, not an IP address or local host (${host})`,
    );
  }
  return value;
}

/** MIME type for a local file of `kinds`, by extension. */
export function mimeFor(file: string, kinds: readonly MediaKind[], flag: string): string {
  const ext = path.extname(file).toLowerCase();
  for (const kind of kinds) {
    const mime = MIME[kind][ext];
    if (mime) return mime;
  }
  const allowed = kinds.flatMap((k) => Object.keys(MIME[k])).join(", ");
  throw new ValidationError(`${flag} must be one of ${allowed} (got ${path.basename(file)})`);
}

/** Upload one local file and return its public URL. */
export async function uploadLocalFile(
  value: string,
  flag: string,
  kinds: readonly MediaKind[],
  client: SumeClient,
  logger: Logger,
): Promise<string> {
  const filePath = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ValidationError(
      `${flag} file not found: ${value} (pass a local path or an https URL)`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`${flag} path is not a file: ${value}`);
  if (stat.size === 0) throw new ValidationError(`${flag} file is empty: ${value}`);
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `${flag} file ${value} is ${formatMb(stat.size)}; Sume accepts uploads up to 2 GiB`,
    );
  }
  const contentType = mimeFor(filePath, kinds, flag);
  const filename = path.basename(filePath);
  logger.info(`Uploading ${filename} (${formatMb(stat.size)}) to Sume...`);
  const data = await fs.openAsBlob(filePath, { type: contentType });
  const url = await client.upload({ data, filename, contentType });
  logger.debug(`Uploaded ${filename}`);
  return url;
}

/** Resolve one value (https URL or local path) for a request field. */
export async function resolveMediaValue(
  value: string,
  flag: string,
  field: string,
  client: SumeClient,
  logger: Logger,
): Promise<string> {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return checkRemoteUrl(trimmed, flag);
  if (/^data:/i.test(trimmed)) {
    throw new ValidationError(`${flag} takes a file path or an https URL, not a data URI`);
  }
  const kind = FIELD_KIND[field] ?? "image";
  return uploadLocalFile(trimmed, flag, [kind], client, logger);
}

/**
 * Check every media input first (so a bad URL fails before anything is
 * uploaded), then upload the local files. Returns the URLs per field.
 */
export async function resolveMediaInputs(
  inputs: MediaInput[],
  client: () => SumeClient,
  logger: Logger,
): Promise<Record<string, string[]>> {
  for (const input of inputs) {
    for (const value of input.values) {
      const trimmed = value.trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) checkRemoteUrl(trimmed, input.flag);
      else if (/^data:/i.test(trimmed)) {
        throw new ValidationError(
          `${input.flag} takes a file path or an https URL, not a data URI`,
        );
      } else {
        mimeFor(trimmed, [FIELD_KIND[input.field] ?? "image"], input.flag);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const input of inputs) {
    const urls: string[] = [];
    for (const value of input.values) {
      urls.push(await resolveMediaValue(value, input.flag, input.field, client(), logger));
    }
    out[input.field] = urls;
  }
  return out;
}

export const ALL_MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio"];
