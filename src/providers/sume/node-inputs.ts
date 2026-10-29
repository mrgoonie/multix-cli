/**
 * Node-only: turn media flag values (--image, --video, --audio, ...) into the
 * URLs Sume fetches.
 *
 * - https URLs pass through after a local check: https only, no credentials
 *   in the URL, and no local or private host (Sume fetches them server-side).
 * - Local files are checked (type matches the flag, size) and uploaded with
 *   Sume's signed upload URL; the public URL it returns goes in the request.
 *
 * Every value is checked before the first upload, so a bad second value never
 * leaves a first one uploaded for nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { ProviderError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import type { SumeClient } from "./client.js";
import type { SumeMediaInput, SumeMediaKind } from "./request-plan.js";

/** Largest local file multix uploads (2 GiB). */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const URL_MAX_LENGTH = 2048;

const MIME: Record<string, { mime: string; media: SumeMediaKind }> = {
  ".png": { mime: "image/png", media: "image" },
  ".jpg": { mime: "image/jpeg", media: "image" },
  ".jpeg": { mime: "image/jpeg", media: "image" },
  ".webp": { mime: "image/webp", media: "image" },
  ".gif": { mime: "image/gif", media: "image" },
  ".mp4": { mime: "video/mp4", media: "video" },
  ".mov": { mime: "video/quicktime", media: "video" },
  ".webm": { mime: "video/webm", media: "video" },
  ".mp3": { mime: "audio/mpeg", media: "audio" },
  ".wav": { mime: "audio/wav", media: "audio" },
  ".m4a": { mime: "audio/mp4", media: "audio" },
  ".aac": { mime: "audio/aac", media: "audio" },
  ".ogg": { mime: "audio/ogg", media: "audio" },
  ".flac": { mime: "audio/flac", media: "audio" },
};

function extensionsFor(media: SumeMediaKind): string {
  return Object.entries(MIME)
    .filter(([, v]) => v.media === media)
    .map(([ext]) => ext)
    .join(", ");
}

/** Check a remote input URL; throws ValidationError. */
export function checkRemoteInput(value: string, flag: string): string {
  if (value.length > URL_MAX_LENGTH) {
    throw new ValidationError(`${flag} URL is longer than ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${flag} is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${flag} URL must not contain a username or password`);
  }
  try {
    checkUrlSafety(value, { provider: "sume", action: "send" });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ValidationError(
        `${flag}: ${error.message.replace(/^Refusing to send /, "cannot use ")}`,
      );
    }
    throw error;
  }
  return value;
}

interface LocalFile {
  filePath: string;
  filename: string;
  mime: string;
  size: number;
}

function checkLocalInput(value: string, flag: string, media: SumeMediaKind): LocalFile {
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
  const type = MIME[path.extname(filePath).toLowerCase()];
  if (!type || type.media !== media) {
    throw new ValidationError(
      `${flag} must be ${media === "image" ? "an" : "a"} ${media} file (${extensionsFor(media)}); got ${value}`,
    );
  }
  if (stat.size === 0) throw new ValidationError(`${flag} file ${value} is empty`);
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new ValidationError(`${flag} file ${value} is larger than 2 GiB`);
  }
  return { filePath, filename: path.basename(filePath), mime: type.mime, size: stat.size };
}

type Checked = { kind: "url"; url: string } | { kind: "file"; file: LocalFile };

function checkValue(value: string, flag: string, media: SumeMediaKind): Checked {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { kind: "url", url: checkRemoteInput(trimmed, flag) };
  }
  if (/^data:/i.test(trimmed)) {
    throw new ValidationError(
      `${flag}: data URIs are not accepted by Sume; pass a file path or an https URL`,
    );
  }
  return { kind: "file", file: checkLocalInput(trimmed, flag, media) };
}

/** Check every media value up front (no network). */
export function checkMediaInputs(media: SumeMediaInput[]): void {
  for (const item of media) for (const v of item.values) checkValue(v, item.flag, item.media);
}

/** Resolve every media value: URLs checked, local files uploaded. */
export async function resolveMediaInputs(
  media: SumeMediaInput[],
  client: SumeClient,
  logger: Logger,
): Promise<Map<SumeMediaInput, string[]>> {
  const checked = media.map((item) => ({
    item,
    values: item.values.map((v) => checkValue(v, item.flag, item.media)),
  }));
  const out = new Map<SumeMediaInput, string[]>();
  for (const { item, values } of checked) {
    const urls: string[] = [];
    for (const value of values) {
      if (value.kind === "url") {
        urls.push(value.url);
        continue;
      }
      const { file } = value;
      logger.info(
        `Uploading ${file.filename} (${(file.size / (1024 * 1024)).toFixed(1)}MB) to Sume...`,
      );
      const data = await fs.openAsBlob(file.filePath, { type: file.mime });
      urls.push(await client.uploadFile({ data, contentType: file.mime, filename: file.filename }));
      logger.debug(`Uploaded ${file.filename}`);
    }
    out.set(item, urls);
  }
  return out;
}
