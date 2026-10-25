/**
 * Local files as fal inputs: validate a path, upload it to fal storage
 * (streamed from disk, never fully buffered) and put the returned URL into
 * the JSON payload at the field named by `--file field=path`. Only files named
 * explicitly are uploaded; the payload is never scanned for paths.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { guessUploadMimeType } from "../../core/upload-mime.js";
import { uploadToFalStorage } from "./storage.js";

/** Largest file `fal upload` / `--file` accepts (2 GiB). */
export const FAL_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Printed before an upload: the hosted URL is a bearer link. */
export const FAL_UPLOAD_NOTICE =
  "Uploading to fal storage: anyone with the returned URL can read the file. fal does not promise when it is deleted unless --expires-in is set.";

export interface FalUploadedFile {
  url: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

export interface FalUploadSettings {
  apiKey: string;
  expiresInSeconds?: number;
  logger: Logger;
}

const REMOTE_REF = /^(https?:|data:)/i;

/** True when `value` is already a URL or data URI that fal can read (nothing to upload). */
export function isRemoteRef(value: string): boolean {
  return REMOTE_REF.test(value.trim());
}

/** Check that `filePath` is a readable, non-empty regular file within the size cap. */
export function checkLocalFile(filePath: string): { absPath: string; size: number } {
  const absPath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ValidationError(
      code === "ENOENT" ? `File not found: ${filePath}` : `Cannot read ${filePath}: ${code ?? e}`,
    );
  }
  if (!stat.isFile()) throw new ValidationError(`Not a regular file: ${filePath}`);
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
  } catch {
    throw new ValidationError(`File is not readable: ${filePath}`);
  }
  if (stat.size === 0) throw new ValidationError(`File is empty: ${filePath}`);
  if (stat.size > FAL_MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `File is too large for upload: ${filePath} (${stat.size} bytes, limit ${FAL_MAX_UPLOAD_BYTES})`,
    );
  }
  return { absPath, size: stat.size };
}

/** Upload one local file to fal storage. */
export async function uploadLocalFile(
  filePath: string,
  settings: FalUploadSettings,
): Promise<FalUploadedFile> {
  const { absPath, size } = checkLocalFile(filePath);
  const fileName = path.basename(absPath);
  const mimeType = guessUploadMimeType(fileName);
  // openAsBlob reads lazily, so a large video is streamed rather than loaded into memory.
  const data = await fs.openAsBlob(absPath, { type: mimeType });
  settings.logger.info(`Uploading ${fileName} (${size} bytes)...`);
  const url = await uploadToFalStorage({
    apiKey: settings.apiKey,
    data,
    fileName,
    contentType: mimeType,
    expiresInSeconds: settings.expiresInSeconds,
    logger: settings.logger,
  });
  return { url, file_name: fileName, mime_type: mimeType, size_bytes: size };
}

export interface FileSpec {
  /** Dotted path into the input object, e.g. `video_url` or `inputs.0.image_url`. */
  field: string;
  value: string;
}

/** Parse repeated `--file field=path` values. */
export function parseFileSpecs(specs: readonly string[]): FileSpec[] {
  const seen = new Set<string>();
  return specs.map((spec) => {
    const eq = spec.indexOf("=");
    const field = eq > 0 ? spec.slice(0, eq).trim() : "";
    const value = eq > 0 ? spec.slice(eq + 1).trim() : "";
    if (!field || !value || field.split(".").some((s) => s === "")) {
      throw new ValidationError(
        `Invalid --file "${spec}": expected field=path, e.g. video_url=./shot.mp4`,
      );
    }
    if (seen.has(field)) throw new ValidationError(`Invalid --file: field "${field}" given twice`);
    seen.add(field);
    return { field, value };
  });
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** A missing intermediate becomes an array when the next segment is an index. */
function containerFor(nextSegment: string): Record<string, unknown> | unknown[] {
  return /^\d+$/.test(nextSegment) ? [] : {};
}

/**
 * Set `value` at a dotted `field` path inside `input`, creating objects (or
 * arrays, before a numeric segment) on the way. Numeric segments index arrays.
 */
export function setInputField(input: Record<string, unknown>, field: string, value: string): void {
  const segments = field.split(".");
  if (segments.some((s) => UNSAFE_KEYS.has(s))) {
    throw new ValidationError(`Invalid --file field "${field}"`);
  }
  let node: Record<string, unknown> | unknown[] = input;
  for (let i = 0; i < segments.length; i++) {
    const key = segments[i] as string;
    const last = i === segments.length - 1;
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!/^\d+$/.test(key) || index > node.length) {
        throw new ValidationError(
          `Invalid --file field "${field}": "${key}" is not an index of the array`,
        );
      }
      if (last) {
        node[index] = value;
        return;
      }
      node[index] ??= containerFor(segments[i + 1] as string);
      const next: unknown = node[index];
      if (typeof next !== "object" || next === null) {
        throw new ValidationError(`Invalid --file field "${field}": "${key}" is not an object`);
      }
      node = next as Record<string, unknown> | unknown[];
      continue;
    }
    if (last) {
      node[key] = value;
      return;
    }
    node[key] ??= containerFor(segments[i + 1] as string);
    const next: unknown = node[key];
    if (typeof next !== "object" || next === null) {
      throw new ValidationError(`Invalid --file field "${field}": "${key}" is not an object`);
    }
    node = next as Record<string, unknown> | unknown[];
  }
}

/**
 * Upload each `--file` path (URLs and data URIs are used as given) and write
 * the URLs into `input`. Returns the uploads made, in order.
 */
export async function applyFileFields(
  input: Record<string, unknown>,
  specs: readonly FileSpec[],
  settings: FalUploadSettings,
): Promise<Array<{ field: string } & FalUploadedFile>> {
  // Check every path and field before uploading anything, so one typo does not
  // leave earlier uploads behind.
  for (const spec of specs) if (!isRemoteRef(spec.value)) checkLocalFile(spec.value);
  const probe = structuredClone(input);
  for (const spec of specs) setInputField(probe, spec.field, "");
  const uploads: Array<{ field: string } & FalUploadedFile> = [];
  if (specs.some((s) => !isRemoteRef(s.value))) settings.logger.warn(FAL_UPLOAD_NOTICE);
  for (const spec of specs) {
    if (isRemoteRef(spec.value)) {
      setInputField(input, spec.field, spec.value.trim());
      continue;
    }
    const uploaded = await uploadLocalFile(spec.value, settings);
    setInputField(input, spec.field, uploaded.url);
    uploads.push({ field: spec.field, ...uploaded });
  }
  return uploads;
}
