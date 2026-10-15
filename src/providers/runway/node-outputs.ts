/**
 * Node-only: save task outputs to disk. Runway output URLs are pre-signed
 * and expire within 24-48 hours (`multix runway status <id> --download`
 * fetches fresh ones).
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), refuse text/HTML/JSON bodies (error pages), stop at
 * MULTIX_MAX_DOWNLOAD_MB, and write through a temporary `.part` file so a
 * failed download never truncates an existing file.
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
import { redactUrl } from "../../core/redact.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";
import { checkOutputUrl, outputFilename } from "./output.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".zip",
  ".wav",
]);
const NON_MEDIA_RE = /^(?:text\/|application\/(?:json|xml|xhtml)|.*\+(?:json|xml))/i;

export interface SaveOutputsOptions {
  outDir: string;
  output?: string;
  logger: Logger;
  /** Appended to the partial-failure error, e.g. a resume command. */
  retryHint?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
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

/** Extension for a saved output: a known media extension from the URL path, else from Content-Type. */
export function outputExtension(url: string, contentType: string | null): string {
  const fromUrl = extFromUrl(url);
  if (fromUrl && MEDIA_EXTS.has(fromUrl)) return fromUrl;
  return extFromContentType(contentType) ?? ".bin";
}

async function saveOne(
  url: string,
  taskId: string,
  index: number,
  count: number,
  opts: SaveOutputsOptions & { maxBytes: number },
): Promise<string> {
  try {
    const { dest } = await downloadToFile(url, {
      dest: (response) => {
        const contentType = response.headers.get("content-type");
        if (contentType && NON_MEDIA_RE.test(contentType.trim())) {
          throw new ProviderError(
            `Output ${index + 1} is not a media file (Content-Type ${contentType.split(";")[0]})`,
            "runway",
          );
        }
        return resolveDestination(taskId, index, count, outputExtension(url, contentType), opts);
      },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: opts.maxBytes,
      fetch: opts.fetch,
      validateUrl: (u) => {
        checkOutputUrl(u);
      },
    });
    return dest;
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.status === 403 || err.status === 404 || err.status === 410)
    ) {
      throw new HttpError(
        err.status,
        "download failed (the signed URL may have expired)",
        err.rawUrl,
      );
    }
    throw err;
  }
}

/**
 * Download every output URL. Each failure is warned (with the URL redacted);
 * after trying all outputs, throws if any failed so the command exits non-zero.
 */
export async function saveTaskOutputs(
  taskId: string,
  urls: string[],
  opts: SaveOutputsOptions,
): Promise<string[]> {
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const withCap = { ...opts, maxBytes: maxDownloadBytes() };
  const saved: string[] = [];
  const failed: number[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;
    opts.logger.debug(`Downloading output ${i + 1} from ${redactUrl(url).slice(0, 200)}`);
    try {
      const dest = await saveOne(url, taskId, i, urls.length, withCap);
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      failed.push(i + 1);
      opts.logger.warn(
        `Download failed for output ${i + 1}: ${e instanceof Error ? e.message : e}`,
      );
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
