/**
 * Node-only: local-file helpers for Gemini commands. They read, stat and open
 * files on disk and read env settings, so `client.ts` stays free of node:*
 * imports and env access and can take a Blob from any runtime.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import {
  type ContentPart,
  DEFAULT_MIN_UPLOAD_BYTES_PER_SEC,
  type FileRef,
  uploadFile,
} from "./client.js";
import { withGeminiKey } from "./key-pool.js";
import { getMimeType } from "./task-resolver.js";

/** Files above this size go through the Files API instead of an inline part. */
export const INLINE_MAX_BYTES = 20 * 1024 * 1024;

export const UPLOAD_MIN_KBPS_ENV = "MULTIX_UPLOAD_MIN_KBPS";

/**
 * Slowest upload speed to allow for, in bytes per second: MULTIX_UPLOAD_MIN_KBPS
 * (kilobytes of 1,000 bytes per second), default 1000 (1 MB/s).
 */
export function minUploadBytesPerSec(): number {
  const raw = resolveKey(UPLOAD_MIN_KBPS_ENV)?.trim();
  if (!raw) return DEFAULT_MIN_UPLOAD_BYTES_PER_SEC;
  const kbps = Number(raw);
  if (!Number.isFinite(kbps) || kbps < 1) {
    throw new ConfigError(
      `${UPLOAD_MIN_KBPS_ENV} must be a number of kilobytes per second, at least 1, got "${raw}"`,
    );
  }
  return kbps * 1000;
}

/**
 * Upload a local file to the Gemini Files API. The file is opened as a
 * file-backed Blob, so it is streamed from disk and never read whole into
 * memory. Uses `apiKey` when given, otherwise rotates through the key pool.
 */
export async function uploadLocalFile(
  filePath: string,
  opts: { apiKey?: string; logger?: Logger; timeoutMs?: number } = {},
): Promise<FileRef> {
  // Read before any request so a bad value fails fast and is never retried.
  const bytesPerSec = minUploadBytesPerSec();
  const blob = await fs.openAsBlob(filePath);
  const source = {
    blob,
    displayName: path.basename(filePath),
    mimeType: getMimeType(filePath),
    label: filePath,
  };
  const upload = (apiKey: string) =>
    uploadFile(source, { ...opts, apiKey, minUploadBytesPerSec: bytesPerSec });
  return opts.apiKey ? upload(opts.apiKey) : withGeminiKey(upload, { logger: opts.logger });
}

/**
 * Build a ContentPart for an inline file (< 20 MB).
 */
export function inlinePart(filePath: string): ContentPart {
  const data = fs.readFileSync(filePath).toString("base64");
  const mimeType = getMimeType(filePath);
  return { inlineData: { mimeType, data } };
}

/** True if file should use Files API (> 20 MB). */
export function shouldUseFileApi(filePath: string): boolean {
  const stat = fs.statSync(filePath);
  return stat.size > INLINE_MAX_BYTES;
}
