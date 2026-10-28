/**
 * Node-only: save a completed Sume job's artifacts to disk.
 * Artifacts are public links on media.sume.com with no documented lifetime,
 * so the CLI downloads them as soon as the job completes.
 *
 * Downloads are https-only, never reach local/private addresses (checked on
 * every redirect hop), and stop at MULTIX_MAX_DOWNLOAD_MB (or the artifact's
 * declared size when that is smaller). Log lines never carry the URL.
 *
 * Naming: `sume-<id8>-NN.<ext>` in the output dir, or `--output`:
 * - an existing directory (or a path ending in a separator) → files go inside it
 * - a file path with one artifact → exactly that path (extension inferred if missing)
 * - a file path with several artifacts → `<base>-NN.<ext>` beside it
 */

import fs from "node:fs";
import path from "node:path";
import { HttpError, ProviderError } from "../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { extFromContentType, extFromUrl } from "../replicate/output.js";
import type { SumeArtifact } from "./types.js";

const DOWNLOAD_TIMEOUT_MS = 600_000;

/** Bodies that are never a generated output: error pages, JSON errors, XML documents. */
const NON_MEDIA_TYPE_RE = /^(text\/|application\/(json|xml|xhtml\+xml|problem\+json)$)/;

export interface SaveArtifactsOptions {
  outDir: string;
  output?: string;
  logger: Logger;
  /** Appended to the partial-failure error, e.g. a resume command. */
  retryHint?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** `sume-<first 8 hex of the job uuid>-NN<ext>`. */
export function outputFilename(jobId: string, index: number, ext: string): string {
  const prefix =
    jobId
      .replace(/^job_/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8) || "output";
  return `sume-${prefix}-${String(index + 1).padStart(2, "0")}${ext}`;
}

function isDirTarget(output: string): boolean {
  if (/[\\/]$/.test(output)) return true;
  try {
    return fs.statSync(output).isDirectory();
  } catch {
    return false;
  }
}

/** Destination for artifact `index` of `count`, given its inferred extension. */
export function resolveDestination(
  jobId: string,
  index: number,
  count: number,
  ext: string,
  opts: { outDir: string; output?: string },
): string {
  if (!opts.output) return path.join(opts.outDir, outputFilename(jobId, index, ext));
  const output = path.resolve(opts.output);
  if (isDirTarget(opts.output)) return path.join(output, outputFilename(jobId, index, ext));
  const givenExt = path.extname(output);
  if (count === 1) return givenExt ? output : `${output}${ext}`;
  const base = givenExt ? output.slice(0, -givenExt.length) : output;
  return `${base}-${String(index + 1).padStart(2, "0")}${ext}`;
}

/**
 * Download every artifact. Each failure is warned (without the URL); after
 * trying all of them, throws if any failed so the command exits non-zero.
 */
export async function saveArtifacts(
  jobId: string,
  artifacts: SumeArtifact[],
  opts: SaveArtifactsOptions,
): Promise<string[]> {
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const cap = maxDownloadBytes();
  const saved: string[] = [];
  const failed: number[] = [];
  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i] as SumeArtifact;
    const url = artifact.url;
    try {
      const { dest } = await downloadToFile(url, {
        dest: (response) => {
          const header = response.headers.get("content-type");
          const type = header?.split(";")[0]?.trim().toLowerCase();
          if (type && NON_MEDIA_TYPE_RE.test(type)) {
            throw new ProviderError(`artifact is ${type}, not media`, "sume");
          }
          const ext =
            extFromUrl(url) ??
            extFromContentType(header ?? artifact.content_type ?? null) ??
            ".bin";
          return resolveDestination(jobId, i, artifacts.length, ext, opts);
        },
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: cap,
        fetch: opts.fetch,
        validateUrl: (hop) => {
          checkUrlSafety(hop, { provider: "sume" });
        },
      });
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      failed.push(i + 1);
      const message =
        e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 410)
          ? `download failed (${e.status}; the artifact may have expired)`
          : e instanceof Error
            ? e.message
            : String(e);
      opts.logger.warn(`Download failed for artifact ${i + 1}: ${message}`);
    }
  }
  if (failed.length > 0) {
    const what =
      saved.length === 0
        ? `none of ${artifacts.length} artifact(s) could be downloaded`
        : `${failed.length} of ${artifacts.length} artifact(s) failed to download (#${failed.join(", #")})`;
    const hint = opts.retryHint ? `. ${opts.retryHint}` : "";
    throw new ProviderError(`Sume job ${jobId}: ${what}${hint}`, "sume");
  }
  return saved;
}
