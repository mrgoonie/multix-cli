/**
 * Node-side wiring for fal storage: validates a local media file, streams it
 * to fal storage (see storage.ts), and maps `--file field=path` flags onto the
 * JSON input of a queue request. Only files named explicitly are uploaded;
 * the input JSON is never scanned for paths.
 */

import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { UPLOAD_EXTENSIONS, uploadMimeTypeFor } from "../atlascloud/upload-mime.js";
import { uploadToFalStorage } from "./storage.js";

export const FAL_MAX_UPLOAD_ENV = "FAL_MAX_UPLOAD_MB";
const DEFAULT_MAX_UPLOAD_MB = 1024;

export const FAL_UPLOAD_NOTICE =
  "fal storage URLs are public to anyone holding the link, and fal decides how long files are kept (no TTL or deletion guarantee). Do not upload media you would not share.";

export interface FalUploadedFile {
  url: string;
  mime_type: string;
  size_bytes: number;
  file_name: string;
}

/** Upload size cap in bytes: FAL_MAX_UPLOAD_MB, default 1024 MB. */
export function falMaxUploadBytes(): number {
  const raw = resolveKey(FAL_MAX_UPLOAD_ENV)?.trim();
  if (!raw) return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new ConfigError(
      `${FAL_MAX_UPLOAD_ENV} must be a positive number of megabytes, got "${raw}"`,
    );
  }
  return Math.floor(mb * 1024 * 1024);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Throws ValidationError unless `file` is a readable, non-empty media file under the size cap. */
export async function inspectLocalMedia(
  file: string,
): Promise<{ abs: string; name: string; mime: string; size: number }> {
  const trimmed = file.trim();
  if (/^(https?|data):/i.test(trimmed)) {
    throw new ValidationError(
      `${trimmed} is already a URL: pass it in --input instead of uploading`,
    );
  }
  const abs = path.resolve(trimmed);
  const name = path.basename(abs);
  // Only media leaves the machine: a stray `--file x=.env` must not become a public URL.
  const mime = uploadMimeTypeFor(name);
  if (!mime) {
    throw new ValidationError(
      `Refusing to upload ${trimmed}: not a supported media file. Allowed extensions: ${UPLOAD_EXTENSIONS.join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`File not found: ${trimmed}`);
  }
  if (!stat.isFile()) throw new ValidationError(`Not a file: ${trimmed}`);
  if (stat.size === 0) throw new ValidationError(`File is empty: ${trimmed}`);
  const maxBytes = falMaxUploadBytes();
  if (stat.size > maxBytes) {
    throw new ValidationError(
      `${trimmed} is ${formatMb(stat.size)}, above the ${formatMb(maxBytes)} upload limit (set ${FAL_MAX_UPLOAD_ENV} to change it)`,
    );
  }
  try {
    await fs.access(abs, fs.constants.R_OK);
  } catch {
    throw new ValidationError(`File is not readable: ${trimmed}`);
  }
  return { abs, name, mime, size: stat.size };
}

/** Upload one local media file to fal storage. Progress goes to `logger`; URLs are never logged. */
export async function uploadLocalFile(
  file: string,
  apiKey: string,
  logger: Logger,
): Promise<FalUploadedFile> {
  const { abs, name, mime, size } = await inspectLocalMedia(file);
  logger.info(`Uploading ${name} (${formatMb(size)}) to fal storage...`);
  // openAsBlob reads the file lazily, so large videos are streamed, not buffered.
  const blob = await openAsBlob(abs, { type: mime });
  const url = await uploadToFalStorage({
    apiKey,
    file: blob,
    fileName: name,
    contentType: mime,
    onProgress: (msg) => logger.info(msg),
  });
  logger.success(`Uploaded ${name}`);
  return { url, mime_type: mime, size_bytes: size, file_name: name };
}

export interface FileFlag {
  /** Dotted path into the input, e.g. "video_url" or "audio.url". */
  field: string[];
  /** True for `field[]=path`: append to an array instead of setting a value. */
  append: boolean;
  file: string;
}

const FIELD_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
/** Keys that would reach Object.prototype instead of the input. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Parse repeated `--file field=path` values. */
export function parseFileFlags(values: string[]): FileFlag[] {
  const seen = new Set<string>();
  return values.map((raw) => {
    const eq = raw.indexOf("=");
    const rawField = eq > 0 ? raw.slice(0, eq).trim() : "";
    const file = eq > 0 ? raw.slice(eq + 1).trim() : "";
    const append = rawField.endsWith("[]");
    const field = append ? rawField.slice(0, -2) : rawField;
    if (
      !field ||
      !file ||
      !FIELD_RE.test(field) ||
      field.split(".").some((k) => FORBIDDEN_KEYS.has(k))
    ) {
      throw new ValidationError(
        `Invalid --file "${raw}": expected field=path (e.g. video_url=./shot.mp4, or image_urls[]=./a.png to append)`,
      );
    }
    if (!append) {
      if (seen.has(field)) throw new ValidationError(`Invalid --file: ${field} is given twice`);
      seen.add(field);
    }
    return { field: field.split("."), append, file };
  });
}

function setField(input: Record<string, unknown>, flag: FileFlag, url: string): void {
  let target = input;
  const keys = flag.field;
  for (const key of keys.slice(0, -1)) {
    const next = Object.hasOwn(target, key) ? target[key] : undefined;
    if (next === undefined) target[key] = {};
    else if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new ValidationError(
        `Invalid --file: ${flag.field.join(".")} crosses a non-object value`,
      );
    }
    target = target[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] as string;
  if (!flag.append) {
    target[last] = url;
    return;
  }
  const current = Object.hasOwn(target, last) ? target[last] : undefined;
  if (current === undefined) target[last] = [url];
  else if (Array.isArray(current)) current.push(url);
  else throw new ValidationError(`Invalid --file: ${flag.field.join(".")}[] is not an array`);
}

/**
 * Validate every `--file` first (nothing is uploaded when one is invalid),
 * then upload each distinct path once and write its URL into `input`.
 */
export async function applyFileFlags(
  input: Record<string, unknown>,
  flags: FileFlag[],
  apiKey: string,
  logger: Logger,
): Promise<FalUploadedFile[]> {
  if (flags.length === 0) return [];
  for (const flag of flags) await inspectLocalMedia(flag.file);
  logger.info(FAL_UPLOAD_NOTICE);
  const byPath = new Map<string, FalUploadedFile>();
  for (const flag of flags) {
    const key = path.resolve(flag.file.trim());
    let uploaded = byPath.get(key);
    if (!uploaded) {
      uploaded = await uploadLocalFile(flag.file, apiKey, logger);
      byPath.set(key, uploaded);
    }
    setField(input, flag, uploaded.url);
  }
  return [...byPath.values()];
}
