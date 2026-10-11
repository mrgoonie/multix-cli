/**
 * Node-only: local-file helpers for Gemini commands. They read, stat and open
 * files on disk, so `client.ts` stays free of node:* imports and can take a
 * Blob from any runtime.
 */

import fs from "node:fs";
import path from "node:path";
import { type ContentPart, type FileRef, type GeminiCallOptions, uploadFile } from "./client.js";
import { getMimeType } from "./task-resolver.js";

/** Files above this size go through the Files API instead of an inline part. */
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Upload a local file to the Gemini Files API. The file is opened as a
 * file-backed Blob, so it is streamed from disk and never read whole into memory.
 */
export async function uploadLocalFile(
  filePath: string,
  opts: GeminiCallOptions & { timeoutMs?: number } = {},
): Promise<FileRef> {
  const blob = await fs.openAsBlob(filePath);
  return uploadFile(
    {
      blob,
      displayName: path.basename(filePath),
      mimeType: getMimeType(filePath),
      label: filePath,
    },
    opts,
  );
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
