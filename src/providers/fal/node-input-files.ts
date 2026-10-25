/**
 * Node-only: local files to fal storage URLs, for `multix fal upload` and
 * `multix fal run --file key=path`. http(s) URLs and data URIs pass through
 * unchanged; nothing is uploaded unless it was named on the command line.
 * Files are read lazily (`fs.openAsBlob`), so a large video is streamed.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { isMediaRef, mimeFromFilename } from "../replicate/output.js";
import { requireFalKey } from "./client.js";
import { uploadToFalStorage } from "./storage.js";

export { parseFileAssignments } from "../replicate/node-input-files.js";

export interface LocalFile {
  path: string;
  name: string;
  size: number;
  contentType: string;
}

export interface UploadedFile {
  url: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

export interface UploadOptions {
  logger: Logger;
  expiresInSeconds?: number;
}

/** `type/subtype` with optional `; name=value` parameters, no control characters. */
const MIME_TYPE =
  /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(\s*;\s*[\w!#$&^.+-]+=("[ !#-~]*"|[\w!#$&^.+-]+))*$/;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Check a local path is a readable, non-empty regular file. */
export function inspectLocalFile(value: string, contentType?: string): LocalFile {
  if (contentType !== undefined && !MIME_TYPE.test(contentType)) {
    throw new ValidationError(
      `Invalid content type "${contentType}": expected a MIME type such as video/mp4`,
    );
  }
  const filePath = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ValidationError(`Input file not found: ${value} (pass a local path or an https URL)`);
  }
  if (!stat.isFile()) throw new ValidationError(`Input path is not a file: ${value}`);
  if (stat.size === 0) throw new ValidationError(`Input file is empty: ${value}`);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new ValidationError(`Input file is not readable: ${value}`);
  }
  const name = path.basename(filePath);
  return {
    path: filePath,
    name,
    size: stat.size,
    contentType: contentType ?? mimeFromFilename(name),
  };
}

/** Upload one checked local file to fal storage. */
export async function uploadLocalFile(file: LocalFile, opts: UploadOptions): Promise<UploadedFile> {
  opts.logger.info(
    `Uploading ${file.name} (${formatMb(file.size)}) to fal storage; anyone with the returned URL can read it.`,
  );
  const blob = await fs.openAsBlob(file.path, { type: file.contentType });
  const url = await uploadToFalStorage({
    file: blob,
    fileName: file.name,
    contentType: file.contentType,
    apiKey: requireFalKey(),
    expiresInSeconds: opts.expiresInSeconds,
    logger: opts.logger,
  });
  return { url, file_name: file.name, mime_type: file.contentType, size_bytes: file.size };
}

/**
 * Apply `--file key=value` assignments to a model input: URLs and data URIs
 * are set as-is, local paths are uploaded and replaced by their fal URL.
 * Every local path is checked before the first upload starts. Each key may
 * be given once; keys name top-level input fields.
 */
export async function resolveFileAssignments(
  input: Record<string, unknown>,
  assignments: Array<[string, string]>,
  opts: UploadOptions,
): Promise<Record<string, unknown>> {
  const keys = new Set<string>();
  for (const [key] of assignments) {
    if (keys.has(key)) throw new ValidationError(`--file ${key} is given more than once`);
    keys.add(key);
  }
  const local = new Map<string, LocalFile>();
  for (const [, value] of assignments) {
    if (!isMediaRef(value) && !local.has(value)) local.set(value, inspectLocalFile(value));
  }
  const uploaded = new Map<string, string>();
  const out = { ...input };
  for (const [key, value] of assignments) {
    const file = local.get(value);
    if (!file) {
      out[key] = value;
      continue;
    }
    let url = uploaded.get(value);
    if (!url) {
      url = (await uploadLocalFile(file, opts)).url;
      uploaded.set(value, url);
    }
    out[key] = url;
  }
  return out;
}
