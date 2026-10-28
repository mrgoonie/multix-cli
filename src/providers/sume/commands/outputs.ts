/**
 * Saving a completed Sume job's artifacts. File names are deterministic per
 * job (`sume-<job id>-NN.<ext>`), so a resumed or repeated download keeps
 * what an earlier run saved and fetches only the missing artifacts.
 * Downloads are https-only, never reach a private address (checked on every
 * redirect hop) and stop at MULTIX_MAX_DOWNLOAD_MB. Artifact URLs may be
 * signed, so only their host is ever logged.
 */

import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "../../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../../core/http-client.js";
import { finalizeGeneratedImages } from "../../../core/image-webp-finalize.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { checkUrlSafety } from "../../../core/url-safety.js";
import { extensionForContentType, outputExtension } from "../../atlascloud/prediction-output.js";
import { SUME_PROVIDER } from "../models.js";
import type { SumeArtifact } from "../types.js";

export interface SaveOptions {
  jobId: string;
  /** File (one artifact), file stem (several) or directory. */
  output?: string;
  imageFormat?: string;
  webp?: boolean;
  logger: Logger;
  /** The command that retries the download, named in errors. */
  retry: string;
  fetch?: typeof globalThis.fetch;
}

export function checkArtifactUrl(url: string): void {
  checkUrlSafety(url, { provider: SUME_PROVIDER });
}

function isDirectoryOutput(output: string): boolean {
  return (
    /[\\/]$/.test(output) ||
    path.extname(output) === "" ||
    (fs.existsSync(output) && fs.statSync(output).isDirectory())
  );
}

function extensionOf(a: SumeArtifact): string {
  const byType = extensionForContentType(a.content_type);
  if (byType) return byType;
  const byUrl = outputExtension(a.url);
  if (byUrl) return byUrl;
  if (a.type === "video" || a.content_type?.startsWith("video/")) return "mp4";
  if (a.type === "audio" || a.content_type?.startsWith("audio/")) return "mp3";
  return "png";
}

/** Planned local paths, and whether an existing file there is an earlier copy to keep. */
export function planArtifactPaths(
  artifacts: SumeArtifact[],
  cfg: { jobId: string; output?: string; outDir?: () => string },
): { paths: string[]; reuse: boolean } {
  const exts = artifacts.map(extensionOf);
  const output = cfg.output;
  const name = (i: number, ext: string) =>
    `sume-${cfg.jobId}-${String(i + 1).padStart(2, "0")}.${ext}`;
  if (!output || isDirectoryOutput(output)) {
    const dir = output ? path.resolve(output) : (cfg.outDir ?? getOutputDir)();
    return { paths: exts.map((ext, i) => path.join(dir, name(i, ext))), reuse: true };
  }
  const abs = path.resolve(output);
  if (artifacts.length === 1) return { paths: [abs], reuse: false };
  const base = abs.slice(0, -path.extname(abs).length);
  return {
    paths: exts.map((ext, i) => `${base}-${String(i + 1).padStart(2, "0")}.${ext}`),
    reuse: false,
  };
}

/** An earlier, complete copy of `file` under the same stem (a PNG may have become WebP). */
function savedCopy(file: string): string | undefined {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const found = names
    .filter((n) => !n.endsWith(".part") && path.basename(n, path.extname(n)) === stem)
    .map((n) => path.join(dir, n))
    .find((p) => {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      return st?.isFile() === true && st.size > 0;
    });
  return found;
}

const isImage = (f: string) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f);

/** Download every artifact; throws when any paid-for artifact could not be saved. */
export async function saveArtifacts(artifacts: SumeArtifact[], o: SaveOptions): Promise<string[]> {
  if (artifacts.length === 0) {
    throw new ProviderError(
      `Sume job ${o.jobId} completed but returned no artifacts.`,
      SUME_PROVIDER,
    );
  }
  const { paths, reuse } = planArtifactPaths(artifacts, { jobId: o.jobId, output: o.output });
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const maxBytes = maxDownloadBytes();
  const saved: string[] = [];
  const downloaded: string[] = [];
  const kept = new Set<string>();
  let failed = 0;
  for (const [i, artifact] of artifacts.entries()) {
    const dest = paths[i] as string;
    const existing = reuse ? savedCopy(dest) : undefined;
    if (existing) {
      saved.push(existing);
      kept.add(existing);
      continue;
    }
    try {
      const result = await downloadToFile(artifact.url, {
        dest,
        maxBytes,
        validateUrl: checkArtifactUrl,
        ...(o.fetch ? { fetch: o.fetch } : {}),
      });
      saved.push(result.dest);
      downloaded.push(result.dest);
      o.logger.debug(`Downloaded ${redactUrl(artifact.url)} -> ${result.dest}`);
    } catch (e) {
      failed++;
      o.logger.warn(
        `Download failed (${redactUrl(artifact.url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const images = downloaded.filter(isImage);
  const fileOutput = o.output && !isDirectoryOutput(o.output) ? o.output : undefined;
  const finals = finalizeGeneratedImages(images, {
    imageFormat: o.imageFormat,
    webp: o.webp,
    output: fileOutput,
    logger: o.logger,
  });
  const files = saved.map((f) => finals[images.indexOf(f)] ?? f);
  for (const f of files) o.logger.info(`${f}${kept.has(f) ? " (already saved)" : ""}`);
  if (failed > 0) {
    throw new ProviderError(
      `Sume job ${o.jobId}: saved ${saved.length} of ${artifacts.length} artifact(s); ${failed} failed. Retry with: ${o.retry}`,
      SUME_PROVIDER,
    );
  }
  return files;
}
