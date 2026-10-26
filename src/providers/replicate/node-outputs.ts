/**
 * Node-only: save prediction media outputs to disk.
 * Replicate output URLs expire (about an hour for API predictions), so the CLI
 * downloads them as soon as the prediction succeeds.
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), warn for hosts other than Replicate's output hosts, and
 * stop at MULTIX_MAX_DOWNLOAD_MB. Network errors, connections dropped
 * mid-download, 408, 429 and 5xx are retried twice with backoff, since an
 * output lost to a blip cannot be fetched again once its URL expires.
 *
 * Naming: `replicate-<id8>-NN.<ext>` in the output dir, or `--output`:
 * - an existing directory (or a path ending in a separator) → files go inside it
 * - a file path with one output → exactly that path (extension inferred if missing)
 * - a file path with several outputs → `<base>-NN.<ext>` beside it
 */

import fs from "node:fs";
import path from "node:path";
import { isTransientHttpError } from "../../core/async-poll.js";
import { HttpError, MultixError, ProviderError } from "../../core/errors.js";
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
/** Wait before each retry of a transient download failure. */
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000];
/** Upper bound for a server's Retry-After between download attempts. */
const MAX_RETRY_WAIT_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SaveMediaOptions {
  outDir: string;
  output?: string;
  logger: Logger;
  /** Appended to the partial-failure error, e.g. a resume command. */
  retryHint?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable for tests; waits between download retries. */
  sleep?: (ms: number) => Promise<void>;
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
  opts: SaveMediaOptions & { maxBytes: number; warnedHosts: Set<string> },
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

  const warned = opts.warnedHosts;
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
            `Output ${item.path} is served from ${host}, not one of Replicate's output hosts (${REPLICATE_DELIVERY_HOST})`,
          );
        }
      },
    });
    return dest;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
      throw new HttpError(err.status, "download failed (output may have expired)", err.rawUrl);
    }
    throw err;
  }
}

/** Socket-level codes of a connection that dropped while the body streamed. */
const DROPPED_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

/**
 * A connection lost mid-body reaches us as a plain error from the stream
 * (undici's `TypeError: terminated`, or a socket code), not as an HttpError.
 * File-system errors and the byte cap are never matched.
 */
export function isDroppedConnection(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof MultixError) return false;
  if (err.name === "TypeError" && err.message === "terminated") return true;
  const codeOf = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  const code = codeOf(err) ?? codeOf(err.cause);
  return typeof code === "string" && DROPPED_CONNECTION_CODES.has(code);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the output host";
  }
}

/**
 * Why a download failed. A network failure surfaces as HTTP status 0, which
 * reads like a server reply, so it and a dropped connection are named for
 * what they are, with the host only (never the signed URL).
 */
export function describeDownloadError(err: unknown, url: string): string {
  if (err instanceof HttpError && err.status === 0) {
    return `network error reaching ${hostOf(err.url)}: ${err.snippet}`;
  }
  if (isDroppedConnection(err)) {
    return `connection to ${hostOf(url)} dropped mid-download: ${(err as Error).message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Short, host-only reason for the info-level retry line. */
function retryReason(err: unknown, url: string): string {
  if (err instanceof HttpError && err.status !== 0)
    return `HTTP ${err.status} from ${hostOf(err.url)}`;
  return describeDownloadError(err, url);
}

/** saveOne, retried on network errors, dropped connections, 408, 429 and 5xx. */
async function saveWithRetry(
  item: MediaOutput,
  predictionId: string,
  index: number,
  count: number,
  opts: SaveMediaOptions & { maxBytes: number; warnedHosts: Set<string> },
): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await saveOne(item, predictionId, index, count, opts);
    } catch (err) {
      const delay = DOWNLOAD_RETRY_DELAYS_MS[attempt];
      const transient = isTransientHttpError(err) || isDroppedConnection(err);
      if (delay === undefined || !transient) throw err;
      const retryAfter = err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0;
      const wait = Math.min(Math.max(delay, retryAfter), MAX_RETRY_WAIT_MS);
      opts.logger.info(
        `Retrying ${item.path} in ${Math.ceil(wait / 1000)}s (${retryReason(err, item.url)})`,
      );
      await sleep(wait);
    }
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
  // One warned-host set per run, so several outputs on one CDN warn once.
  const withCap = { ...opts, maxBytes: maxDownloadBytes(), warnedHosts: new Set<string>() };
  const saved: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item) continue;
    opts.logger.debug(`Downloading ${item.path} from ${redactUrl(item.url).slice(0, 200)}`);
    try {
      const dest = await saveWithRetry(item, predictionId, i, media.length, withCap);
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      failed.push(item.path);
      opts.logger.warn(`Download failed for ${item.path}: ${describeDownloadError(e, item.url)}`);
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
