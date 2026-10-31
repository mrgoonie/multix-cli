/**
 * Node-only: save TopView outputs (Legacy task results and API Platform
 * prediction outputs) to disk. Legacy result URLs are presigned and valid for
 * 7 days; Platform URLs "may expire", so the CLI downloads them promptly.
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), and stop at MULTIX_MAX_DOWNLOAD_MB. Platform outputs
 * may also be inline `data:` URIs, which are decoded and written directly.
 * Log lines never carry the signed URL.
 *
 * Naming: `topview-<id8>-NN.<ext>` in the output dir, or `--output`:
 * - an existing directory (or a path ending in a separator) → files go inside it
 * - a file path with one output → exactly that path (extension inferred if missing)
 * - a file path with several outputs → `<base>-NN.<ext>` beside it
 */

import fs from "node:fs";
import path from "node:path";
import { HttpError, ProviderError } from "../../core/errors.js";
import type { FetchLike } from "../../core/fetch-json.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";
import { PROVIDER } from "./errors.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;
const DATA_URI_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(;[a-z0-9=.+-]+)*;base64,/i;

/** Bodies that are never a generated output: error pages, JSON errors, XML documents. */
const NON_MEDIA_TYPE_RE = /^(text\/|application\/(json|xml|xhtml\+xml|problem\+json)$)/;

export interface SaveOutputsOptions {
  outDir: string;
  output?: string;
  logger: Logger;
  /** Appended to the partial-failure error, e.g. a resume command. */
  retryHint?: string;
  fetch?: FetchLike;
}

/** `topview-<first 8 of id>-NN<ext>`; non-alphanumerics are stripped from the id. */
export function outputFilename(taskId: string, index: number, ext: string): string {
  const prefix = taskId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "output";
  return `topview-${prefix}-${String(index + 1).padStart(2, "0")}${ext}`;
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

function saveDataUri(uri: string, dest: (ext: string) => string): string {
  const match = DATA_URI_RE.exec(uri);
  if (!match) throw new ProviderError("output is a data URI that is not base64", PROVIDER);
  const ext = extFromContentType(match[1]) ?? ".bin";
  const file = dest(ext);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(uri.slice(match[0].length), "base64"));
  return file;
}

/**
 * Save every output. Each failure is warned (without the URL); after trying
 * all outputs, throws if any failed so the command exits non-zero.
 */
export async function saveOutputs(
  taskId: string,
  urls: readonly string[],
  opts: SaveOutputsOptions,
): Promise<string[]> {
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const maxBytes = maxDownloadBytes();
  const saved: string[] = [];
  const failed: number[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i] as string;
    const destFor = (ext: string) => resolveDestination(taskId, i, urls.length, ext, opts);
    try {
      let dest: string;
      if (url.startsWith("data:")) {
        dest = saveDataUri(url, destFor);
      } else {
        ({ dest } = await downloadToFile(url, {
          dest: (response) => {
            const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            if (type && NON_MEDIA_TYPE_RE.test(type)) {
              throw new ProviderError(
                `output is ${type}, not media (the output URL may have expired)`,
                PROVIDER,
              );
            }
            return destFor(
              extFromUrl(url) ?? extFromContentType(response.headers.get("content-type")) ?? ".bin",
            );
          },
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes,
          fetch: opts.fetch,
          validateUrl: (hop) => {
            checkUrlSafety(hop, { provider: PROVIDER });
          },
        }));
      }
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
    throw new ProviderError(`TopView ${taskId}: ${what}${hint}`, PROVIDER);
  }
  return saved;
}
