/**
 * Node-only: turn `--image` / `--ref` values into image inputs Runway accepts.
 * https://docs.dev.runwayml.com/assets/inputs/
 *
 * - https URLs pass through after the checks Runway applies itself (domain
 *   name, not an IP; at most 2048 characters) plus the local/private host
 *   refusal, so a typo fails here instead of in a task.
 * - runway:// URIs (earlier ephemeral uploads) pass through.
 * - data: URIs must be JPEG, PNG or WebP and at most 5 MB encoded.
 * - Local JPEG/PNG/WebP files (checked by their bytes) up to the 5 MB data
 *   URI limit are inlined; larger ones, up to 200 MB, go through an ephemeral
 *   upload, which Runway keeps for 24 hours.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { sniffImageKind } from "../../core/image-header.js";
import type { Logger } from "../../core/logger.js";
import { isNonPublicHost } from "../../core/url-safety.js";
import type { RunwayClient } from "./client.js";

export const DATA_URI_MAX_CHARS = 5 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const URL_MAX_CHARS = 2048;

const MIME_BY_KIND = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
const DATA_URI_RE = /^data:(image\/(?:png|jpe?g|webp));base64,/i;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function checkRemoteImageUrl(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${flag}: invalid URL`);
  }
  if (url.protocol !== "https:") {
    throw new ValidationError(`${flag}: Runway only fetches https:// URLs (or pass a local file)`);
  }
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host) || isNonPublicHost(host)) {
    throw new ValidationError(
      `${flag}: Runway needs a public domain name, not an IP address or local host (${host})`,
    );
  }
  if (value.length > URL_MAX_CHARS) {
    throw new ValidationError(
      `${flag}: URLs longer than ${URL_MAX_CHARS} characters are refused by Runway`,
    );
  }
  return value;
}

/** Resolve one image value (`path|https URL|data URI|runway:// URI`) into a Runway input URI. */
export async function resolveImageInput(
  value: string,
  flag: string,
  client: RunwayClient,
  logger: Logger,
): Promise<string> {
  const trimmed = value.trim();
  if (/^runway:\/\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return checkRemoteImageUrl(trimmed, flag);
  if (/^data:/i.test(trimmed)) {
    if (!DATA_URI_RE.test(trimmed)) {
      throw new ValidationError(`${flag}: data URIs must be base64 JPEG, PNG or WebP images`);
    }
    if (trimmed.length > DATA_URI_MAX_CHARS) {
      throw new ValidationError(`${flag}: data URIs are limited to 5MB; pass a local file instead`);
    }
    return trimmed;
  }

  const filePath = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ValidationError(
      `${flag}: file not found: ${trimmed} (pass a local path or an https URL)`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`${flag}: not a file: ${trimmed}`);
  if (stat.size === 0) throw new ValidationError(`${flag}: file is empty: ${trimmed}`);
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `${flag}: ${trimmed} is ${formatMb(stat.size)}; Runway accepts images up to 200MB`,
    );
  }

  const bytes = fs.readFileSync(filePath);
  const kind = sniffImageKind(bytes);
  if (!kind) {
    throw new ValidationError(`${flag}: ${trimmed} is not a JPEG, PNG or WebP image`);
  }
  const contentType = MIME_BY_KIND[kind];
  const prefix = `data:${contentType};base64,`;
  const encodedLength = prefix.length + Math.ceil(bytes.length / 3) * 4;
  const filename = path.basename(filePath);
  if (encodedLength <= DATA_URI_MAX_CHARS) {
    logger.debug(`Inlining ${filename} (${bytes.length} bytes) as a data URI`);
    return `${prefix}${bytes.toString("base64")}`;
  }

  logger.info(`Uploading ${filename} (${formatMb(bytes.length)}) to Runway ephemeral storage...`);
  const uri = await client.uploadEphemeral({
    data: new Blob([bytes], { type: contentType }),
    filename,
    contentType,
  });
  logger.debug(`Uploaded ${filename}`);
  return uri;
}

const TAGGED_REF_RE = /^([A-Za-z][A-Za-z0-9_]{2,15})=(.+)$/;

/**
 * Split `--ref` values into `{ tag?, value }`. `tag=path` names the image
 * for `@tag` mentions in the prompt; a URL is never mistaken for a tag
 * because its scheme ends in `:` before any `=`.
 */
export function parseReferenceArg(raw: string): { tag?: string; value: string } {
  const match = TAGGED_REF_RE.exec(raw.trim());
  if (match?.[1] && match[2]) return { tag: match[1], value: match[2].trim() };
  return { value: raw.trim() };
}
