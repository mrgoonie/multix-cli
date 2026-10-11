/**
 * Node-only: turn local file paths into values Replicate accepts as model inputs.
 * - http(s) URLs and data URIs pass through unchanged.
 * - Files up to 256 KB become data URIs (Replicate does not store them).
 * - Larger files (< 100 MB) are uploaded via the Files API; the file's
 *   `urls.get` is passed to the model.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { ReplicateClient } from "./client.js";
import { isMediaRef, mimeFromFilename } from "./output.js";

export const DATA_URI_MAX_BYTES = 256 * 1024;
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Resolve a `path|url` CLI value into a URL or data URI for a model input. */
export async function resolveFileInput(
  value: string,
  client: ReplicateClient,
  logger: Logger,
): Promise<string> {
  if (isMediaRef(value)) return value;

  const filePath = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new ValidationError(`Input file not found: ${value} (pass a local path or an https URL)`);
  }
  if (!stat.isFile()) throw new ValidationError(`Input path is not a file: ${value}`);
  if (stat.size === 0) throw new ValidationError(`Input file is empty: ${value}`);
  if (stat.size >= UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `Input file ${value} is ${formatMb(stat.size)}; Replicate accepts uploads under 100MB. Host it and pass an https URL instead.`,
    );
  }

  const filename = path.basename(filePath);
  const contentType = mimeFromFilename(filename);
  const bytes = fs.readFileSync(filePath);
  if (stat.size <= DATA_URI_MAX_BYTES) {
    logger.debug(`Inlining ${filename} (${stat.size} bytes) as a data URI`);
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }

  logger.info(`Uploading ${filename} (${formatMb(stat.size)}) to Replicate Files...`);
  const file = await client.uploadFile({
    data: new Blob([bytes], { type: contentType }),
    filename,
    contentType,
  });
  logger.debug(`Uploaded ${filename} as file ${file.id}`);
  return file.urls.get;
}

/** Parse repeated `--file key=path` flags into [inputKey, pathOrUrl] pairs. */
export function parseFileAssignments(values: string[] | undefined): Array<[string, string]> {
  return (values ?? []).map((raw) => {
    const eq = raw.indexOf("=");
    const key = eq > 0 ? raw.slice(0, eq).trim() : "";
    const value = eq > 0 ? raw.slice(eq + 1).trim() : "";
    if (!key || !value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ValidationError(`Invalid --file "${raw}" — expected key=path (e.g. image=./a.png)`);
    }
    return [key, value];
  });
}
