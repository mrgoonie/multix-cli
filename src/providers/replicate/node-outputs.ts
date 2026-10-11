/**
 * Node-only: save prediction media outputs to disk.
 * Replicate output URLs expire (about an hour for API predictions), so the CLI
 * downloads them as soon as the prediction succeeds.
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), warn for hosts other than replicate.delivery, and stop
 * at MULTIX_MAX_DOWNLOAD_MB.
 *
 * Naming: `replicate-<id8>-NN.<ext>` in the output dir, or `--output`:
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
import {
  type MediaOutput,
  REPLICATE_DELIVERY_HOST,
  checkOutputUrl,
  extFromContentType,
  extFromUrl,
  outputFilename,
} from "./output.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;

export interface SaveMediaOptions {
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

/** Destination for media item `index` of `count`, given its inferred extension. */
export function resolveDestination(
  predictionId: string,
  index: number,
  count: number,
  ext: string,
  opts: { outDir: string; output?: string },
): string {
  if (!opts.output) return path.join(opts.outDir, outputFilename(predictionId, index, ext));
  const output = path.resolve(opts.output);
  if (isDirTarget(opts.output)) return path.join(output, outputFilename(predictionId, index, ext));
  const givenExt = path.extname(output);
  if (count === 1) return givenExt ? output : `${output}${ext}`;
  const base = givenExt ? output.slice(0, -givenExt.length) : output;
  return `${base}-${String(index + 1).padStart(2, "0")}${ext}`;
}

async function saveOne(
  item: MediaOutput,
  predictionId: string,
  index: number,
  count: number,
  opts: SaveMediaOptions & { maxBytes: number },
): Promise<string> {
  if (item.url.startsWith("data:")) {
    const comma = item.url.indexOf(",");
    const meta = item.url.slice(5, comma);
    const payload = item.url.slice(comma + 1);
    const bytes = meta.endsWith(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload));
    const dest = resolveDestination(
      predictionId,
      index,
      count,
      extFromUrl(item.url) ?? ".bin",
      opts,
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return dest;
  }

  const warned = new Set<string>();
  try {
    const { dest } = await downloadToFile(item.url, {
      dest: (response) => {
        const ext =
          extFromUrl(item.url) ??
          extFromContentType(response.headers.get("content-type")) ??
          ".bin";
        return resolveDestination(predictionId, index, count, ext, opts);
      },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: opts.maxBytes,
      fetch: opts.fetch,
      validateUrl: (url) => {
        const { host, trusted } = checkOutputUrl(url);
        if (!trusted && !warned.has(host)) {
          warned.add(host);
          opts.logger.warn(
            `Output ${item.path} is served from ${host}, not ${REPLICATE_DELIVERY_HOST}`,
          );
        }
      },
    });
    return dest;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
      throw new HttpError(err.status, "download failed (output may have expired)", item.url);
    }
    throw err;
  }
}

/**
 * Download every media output. Each failure is warned (with the URL redacted);
 * after trying all outputs, throws if any failed so the command exits non-zero.
 */
export async function saveMediaOutputs(
  predictionId: string,
  media: MediaOutput[],
  opts: SaveMediaOptions,
): Promise<string[]> {
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const withCap = { ...opts, maxBytes: maxDownloadBytes() };
  const saved: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item) continue;
    opts.logger.debug(`Downloading ${item.path} from ${redactUrl(item.url).slice(0, 200)}`);
    try {
      const dest = await saveOne(item, predictionId, i, media.length, withCap);
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      failed.push(item.path);
      opts.logger.warn(`Download failed for ${item.path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed.length > 0) {
    const what =
      saved.length === 0
        ? `none of ${media.length} output file(s) could be downloaded`
        : `${failed.length} of ${media.length} output file(s) failed to download (${failed.join(", ")})`;
    const hint = opts.retryHint ? `. ${opts.retryHint}` : "";
    throw new ProviderError(`Prediction ${predictionId}: ${what}${hint}`, "replicate");
  }
  return saved;
}
