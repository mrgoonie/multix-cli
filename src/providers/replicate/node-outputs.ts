/**
 * Node-only: save prediction media outputs to disk.
 * Replicate output URLs expire (about an hour for API predictions), so the CLI
 * downloads them as soon as the prediction succeeds.
 *
 * Naming: `replicate-<id8>-NN.<ext>` in the output dir, or `--output`:
 * - an existing directory (or a path ending in a separator) → files go inside it
 * - a file path with one output → exactly that path (extension inferred if missing)
 * - a file path with several outputs → `<base>-NN.<ext>` beside it
 */

import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, ProviderError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { redactUrl } from "../../core/redact.js";
import { type MediaOutput, extFromContentType, extFromUrl, outputFilename } from "./output.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;

export interface SaveMediaOptions {
  outDir: string;
  output?: string;
  logger: Logger;
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

async function writeResponse(response: Response, dest: string): Promise<void> {
  if (!response.body) throw new HttpError(0, "Response body is null", response.url);
  const fileStream = fs.createWriteStream(dest);
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      fileStream,
    );
  } catch (err) {
    // Windows keeps the handle until close; wait so the partial file can be removed.
    if (!fileStream.closed) await once(fileStream, "close");
    throw err;
  }
}

async function saveOne(
  item: MediaOutput,
  predictionId: string,
  index: number,
  count: number,
  opts: SaveMediaOptions,
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

  const doFetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let response: Response;
  try {
    response = await doFetch(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (cause) {
    throw new HttpError(0, cause instanceof Error ? cause.message : String(cause), item.url);
  }
  if (!response.ok) {
    const hint =
      response.status === 404 || response.status === 410 ? " (output may have expired)" : "";
    throw new HttpError(response.status, `download failed${hint}`, item.url);
  }
  const ext =
    extFromUrl(item.url) ?? extFromContentType(response.headers.get("content-type")) ?? ".bin";
  const dest = resolveDestination(predictionId, index, count, ext, opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await writeResponse(response, dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return dest;
}

/**
 * Download every media output. Individual failures are warned (with the URL
 * redacted) and skipped; throws when media existed but nothing was saved.
 */
export async function saveMediaOutputs(
  predictionId: string,
  media: MediaOutput[],
  opts: SaveMediaOptions,
): Promise<string[]> {
  const saved: string[] = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item) continue;
    opts.logger.debug(`Downloading ${item.path} from ${redactUrl(item.url).slice(0, 200)}`);
    try {
      const dest = await saveOne(item, predictionId, i, media.length, opts);
      saved.push(dest);
      opts.logger.success(`Saved ${dest}`);
    } catch (e) {
      opts.logger.warn(`Download failed for ${item.path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (media.length > 0 && saved.length === 0) {
    throw new ProviderError(
      `Prediction ${predictionId} produced ${media.length} output file(s) but none could be downloaded`,
      "replicate",
    );
  }
  return saved;
}
