/**
 * Node-only: save Runway task outputs to disk.
 * Output URLs are signed and expire within 24–48 hours, so the CLI downloads
 * them as soon as the task succeeds.
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), and stop at MULTIX_MAX_DOWNLOAD_MB. Log lines never
 * carry the signed URL.
 *
 * Naming: `runway-<id8>-NN.<ext>` in the output dir, or `--output`:
 * - an existing directory (or a path ending in a separator) → files go inside it
 * - a file path with one output → exactly that path (extension inferred if missing)
 * - a file path with several outputs → `<base>-NN.<ext>` beside it
 */

import fs from "node:fs";
import path from "node:path";
import { HttpError, ProviderError } from "../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;

export interface SaveOutputsOptions {
  outDir: string;
  output?: string;
  logger: Logger;
  /** Appended to the partial-failure error, e.g. a resume command. */
  retryHint?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** `runway-<first 8 of id>-NN<ext>`; non-alphanumerics are stripped from the id. */
export function outputFilename(taskId: string, index: number, ext: string): string {
  const prefix = taskId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "output";
  return `runway-${prefix}-${String(index + 1).padStart(2, "0")}${ext}`;
}

function isDirTarget(output: string): boolean {
  if (/[\\/]$/.test(output)) return true;
  try {
    return fs.statSync(output).isDirectory();
  } catch {
    return false;
  }
}

/** Destination for output `index` of `count`, given its inferred extension. */
export function resolveDestination(
  taskId: string,
  index: number,
  count: number,
  ext: string,
  opts: { outDir: string; output?: string },
): string {
  if (!opts.output) return path.join(opts.outDir, outputFilename(taskId, index, ext));
  const output = path.resolve(opts.output);
  if (isDirTarget(opts.output)) return path.join(output, outputFilename(taskId, index, ext));
  const givenExt = path.extname(output);
  if (count === 1) return givenExt ? output : `${output}${ext}`;
  const base = givenExt ? output.slice(0, -givenExt.length) : output;
  return `${base}-${String(index + 1).padStart(2, "0")}${ext}`;
}

/**
 * Download every output URL. Each failure is warned (without the URL); after
 * trying all outputs, throws if any failed so the command exits non-zero.
 */
export async function saveTaskOutputs(
  taskId: string,
  urls: string[],
  opts: SaveOutputsOptions,
): Promise<string[]> {
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const maxBytes = maxDownloadBytes();
  const saved: string[] = [];
  const failed: number[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i] as string;
    try {
      const { dest } = await downloadToFile(url, {
        dest: (response) => {
          const ext =
            extFromUrl(url) ?? extFromContentType(response.headers.get("content-type")) ?? ".bin";
          return resolveDestination(taskId, i, urls.length, ext, opts);
        },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes,
        fetch: opts.fetch,
        validateUrl: (hop) => {
          checkUrlSafety(hop, { provider: "runway" });
        },
      });
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      failed.push(i + 1);
      const message =
        e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 410)
          ? `download failed (${e.status}; the output URL may have expired)`
          : e instanceof Error
            ? e.message
            : String(e);
      opts.logger.warn(`Download failed for output ${i + 1}: ${message}`);
    }
  }
  if (failed.length > 0) {
    const what =
      saved.length === 0
        ? `none of ${urls.length} output file(s) could be downloaded`
        : `${failed.length} of ${urls.length} output file(s) failed to download (#${failed.join(", #")})`;
    const hint = opts.retryHint ? `. ${opts.retryHint}` : "";
    throw new ProviderError(`Runway task ${taskId}: ${what}${hint}`, "runway");
  }
  return saved;
}
