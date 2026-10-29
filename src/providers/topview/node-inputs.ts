/**
 * Node-only: turn file flags (`--file`, `--video`, `--audio`, `--logo`, ...)
 * into TopView Legacy fileIds. Legacy task bodies take fileIds only, never
 * public URLs, so every input is uploaded through the presigned-URL flow.
 *
 * - A local path must exist and have an extension the upload credential
 *   accepts for that flag (image: png/jpg/jpeg/bmp/webp, audio: mp3/wav/m4a,
 *   video: mp4/avi/mov).
 * - An https:// URL is fetched by multix first (https only, never localhost
 *   or a private address, checked on every redirect hop, capped at
 *   MULTIX_MAX_DOWNLOAD_MB) into a temporary directory that is always
 *   removed, then uploaded like a local file. Logs name the host only.
 *
 * `prepareFileInput` validates without any request, so every flag is checked
 * before the first upload or paid submit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";
import { PROVIDER } from "./errors.js";
import type { TopviewLegacyClient } from "./legacy-client.js";
import { LEGACY_UPLOAD_FORMATS, type UploadKind } from "./models.js";

const REMOTE_TIMEOUT_MS = 300_000;

export interface PreparedFile {
  flag: string;
  kinds: readonly UploadKind[];
  /** Absolute path of a local file. */
  path?: string;
  /** Remote https URL (fetched at upload time). */
  url?: string;
  /** Upload format without the dot; undefined for a URL without a usable extension. */
  format?: string;
  /** Base name for logs (never the URL query string). */
  name: string;
}

function allowedFormats(kinds: readonly UploadKind[]): string[] {
  return kinds.flatMap((k) => [...LEGACY_UPLOAD_FORMATS[k]]);
}

function formatOf(ext: string | undefined, kinds: readonly UploadKind[]): string | undefined {
  const format = ext?.replace(/^\./, "").toLowerCase();
  return format && allowedFormats(kinds).includes(format) ? format : undefined;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Validate a file flag value (local path or https URL) without any request. */
export function prepareFileInput(
  value: string,
  flag: string,
  kinds: readonly UploadKind[],
): PreparedFile {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${flag} must not be empty`);
  const allowed = allowedFormats(kinds).join(", ");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ValidationError(`${flag} is not a valid URL`);
    }
    if (url.protocol !== "https:") {
      throw new ValidationError(`${flag} URL must use https:// (or pass a local file)`);
    }
    if (url.username || url.password) {
      throw new ValidationError(`${flag} URL must not contain a username or password`);
    }
    // Refuse local and private targets before anything is fetched.
    try {
      checkUrlSafety(trimmed, { provider: PROVIDER, action: "fetch" });
    } catch (e) {
      throw new ValidationError(`${flag}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ext = extFromUrl(trimmed);
    if (ext && !formatOf(ext, kinds)) {
      throw new ValidationError(`${flag} must be one of ${allowed} (got ${ext})`);
    }
    const name = path.posix.basename(url.pathname) || url.hostname;
    return { flag, kinds, url: trimmed, format: formatOf(ext, kinds), name };
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
  if (stat.size === 0) throw new ValidationError(`${flag} file is empty: ${value}`);
  const format = formatOf(path.extname(filePath), kinds);
  if (!format) {
    throw new ValidationError(`${flag} must be a ${allowed} file (got ${value})`);
  }
  return { flag, kinds, path: filePath, format, name: path.basename(filePath) };
}

async function uploadLocal(
  client: TopviewLegacyClient,
  filePath: string,
  format: string,
  name: string,
  logger: Logger,
): Promise<string> {
  // File-backed: streamed from disk, never read whole into memory.
  const blob = await fs.openAsBlob(filePath);
  logger.info(`Uploading ${name} (${formatMb(blob.size)}) to TopView...`);
  const fileId = await client.uploadFile({ data: blob, format, filename: name });
  logger.debug(`Uploaded ${name}: fileId ${fileId}`);
  return fileId;
}

/** Upload one prepared input and return its fileId. */
export async function uploadPreparedFile(
  client: TopviewLegacyClient,
  file: PreparedFile,
  logger: Logger,
): Promise<string> {
  if (file.path && file.format)
    return uploadLocal(client, file.path, file.format, file.name, logger);
  const url = file.url as string;
  const host = new URL(url).hostname;
  const maxBytes = maxDownloadBytes();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-topview-"));
  try {
    logger.info(`Fetching ${file.flag} from ${host}...`);
    let format = file.format;
    const { dest } = await downloadToFile(url, {
      dest: (response) => {
        format ??= formatOf(extFromContentType(response.headers.get("content-type")), file.kinds);
        if (!format) {
          throw new ValidationError(
            `${file.flag} from ${host} is not one of ${allowedFormats(file.kinds).join(", ")}`,
          );
        }
        return path.join(dir, `input.${format}`);
      },
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxBytes,
      validateUrl: (hop) => {
        checkUrlSafety(hop, { provider: PROVIDER, action: "fetch" });
      },
    });
    return await uploadLocal(client, dest, format as string, file.name, logger);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Upload several prepared inputs in order. */
export async function uploadPreparedFiles(
  client: TopviewLegacyClient,
  files: readonly PreparedFile[],
  logger: Logger,
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) ids.push(await uploadPreparedFile(client, file, logger));
  return ids;
}
