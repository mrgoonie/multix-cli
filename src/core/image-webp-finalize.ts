/**
 * Post-processing for generated/edited images: convert to WebP by default.
 *
 * Rules:
 * - Default target is WebP via `cwebp -q 85 -m 6 -metadata none`.
 * - Opt out with `--image-format original`, `--no-webp`, or MULTIX_IMAGE_FORMAT=original
 *   to keep the provider's format and quality untouched.
 * - An explicit user format request wins: a non-.webp `--output` extension, or a
 *   provider-level format flag the caller reports as explicit, keeps the original.
 * - Each WebP is verified (same width/height, alpha preserved) before delivery;
 *   on any failure the original file is kept and the bad WebP removed.
 * - Only files this CLI run wrote are deleted. User-supplied inputs never reach here.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Option } from "commander";
import { ValidationError } from "./errors.js";
import { readImageHeaderFromFile } from "./image-header.js";
import type { Logger } from "./logger.js";

export type ImageFormatMode = "webp" | "original";

export const CWEBP_ARGS = ["-q", "85", "-m", "6", "-metadata", "none"] as const;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

/** `--image-format <webp|original>`; add to every image generate/edit command. */
export function imageFormatOption(): Option {
  return new Option(
    "--image-format <mode>",
    "Final image format: webp (default, cwebp -q 85) | original (keep provider format/quality)",
  );
}

/** `--no-webp` shorthand for `--image-format original`. */
export function noWebpOption(): Option {
  return new Option("--no-webp", "Keep the provider's original image format and quality");
}

export interface ImageFormatOpts {
  imageFormat?: string;
  webp?: boolean;
  output?: string;
}

/** Resolve the effective mode; explicit user choices beat the WebP default. */
export function resolveImageFormatMode(
  opts: ImageFormatOpts,
  explicitProviderFormat = false,
): ImageFormatMode {
  if (opts.webp === false && opts.imageFormat === undefined) return "original";
  const raw = opts.imageFormat ?? process.env.MULTIX_IMAGE_FORMAT;
  if (raw !== undefined && raw !== "") {
    const mode = raw.toLowerCase();
    if (mode !== "webp" && mode !== "original") {
      throw new ValidationError(`Invalid --image-format: ${raw}. Valid: webp, original`);
    }
    return mode;
  }
  if (explicitProviderFormat) return "original";
  const ext = opts.output ? path.extname(opts.output).toLowerCase() : "";
  if (ext && ext !== ".webp" && IMAGE_EXTS.has(ext)) return "original";
  return "webp";
}

export function hasCwebp(): boolean {
  const res = spawnSync("cwebp", ["-version"], { stdio: "ignore" });
  return !res.error && res.status === 0;
}

function webpTarget(file: string): string {
  const ext = path.extname(file);
  return ext.toLowerCase() === ".webp" ? file : `${file.slice(0, -ext.length || undefined)}.webp`;
}

/**
 * Convert one CLI-written image to WebP and verify it.
 * Returns the delivered path (WebP on success, original on failure).
 */
export function convertToWebp(file: string, logger?: Logger, keepPath = false): string {
  const src = readImageHeaderFromFile(file);
  if (!src) {
    logger?.warn(`Skipping WebP conversion (unrecognized image): ${file}`);
    return file;
  }
  if (src.kind === "webp") {
    // Already WebP content; just make sure the extension matches.
    const target = keepPath ? file : webpTarget(file);
    if (target !== file) fs.renameSync(file, target);
    return target;
  }

  // An explicit --output path the CLI wrote directly keeps its exact name.
  const target = keepPath ? file : webpTarget(file);
  // Converting in place (e.g. PNG bytes saved as foo.webp) needs a temp output.
  const tmp = `${target}.tmp-${process.pid}.webp`;
  const res = spawnSync("cwebp", [...CWEBP_ARGS, file, "-o", tmp], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    fs.rmSync(tmp, { force: true });
    logger?.warn(`cwebp failed, keeping original ${file}: ${res.stderr || res.error?.message}`);
    return file;
  }

  const out = fs.existsSync(tmp) ? readImageHeaderFromFile(tmp) : undefined;
  const problem = !out
    ? "output is not a valid WebP"
    : out.width !== src.width || out.height !== src.height
      ? `size changed ${src.width}x${src.height} -> ${out.width}x${out.height}`
      : src.hasAlpha && !out.hasAlpha
        ? "transparency lost"
        : undefined;
  if (problem) {
    fs.rmSync(tmp, { force: true });
    logger?.warn(`WebP verification failed (${problem}), keeping original ${file}`);
    return file;
  }

  // Verified: the source is an intermediate this CLI wrote, so it can go.
  if (target !== file) fs.rmSync(file, { force: true });
  fs.renameSync(tmp, target);
  logger?.debug(`WebP verified ${out?.width}x${out?.height} alpha=${out?.hasAlpha}: ${target}`);
  return target;
}

/**
 * Apply the image-format policy to files this command just wrote.
 * `output` is the user's --output path; when it held a copy of files[0],
 * it is refreshed with the converted bytes.
 */
export function finalizeGeneratedImages(
  files: string[],
  opts: ImageFormatOpts & { logger?: Logger; explicitProviderFormat?: boolean },
): string[] {
  const mode = resolveImageFormatMode(opts, opts.explicitProviderFormat);
  if (mode === "original" || files.length === 0) return files;
  if (!hasCwebp()) {
    opts.logger?.warn(
      "cwebp not found on PATH; keeping original image format (install libwebp, or pass --image-format original)",
    );
    return files;
  }

  const outputAbs = opts.output ? path.resolve(opts.output) : undefined;
  const wroteOutputDirectly =
    outputAbs !== undefined && files.some((f) => path.resolve(f) === outputAbs);
  const finals = files.map((f) =>
    convertToWebp(f, opts.logger, outputAbs !== undefined && path.resolve(f) === outputAbs),
  );

  if (opts.output && outputAbs && !wroteOutputDirectly && finals[0] && fs.existsSync(outputAbs)) {
    // --output held a copy of the pre-conversion file; replace it with the final bytes.
    const outExt = path.extname(outputAbs).toLowerCase();
    if (
      (outExt === ".webp" || outExt === "") &&
      path.extname(finals[0]).toLowerCase() === ".webp"
    ) {
      fs.copyFileSync(finals[0], outputAbs);
    }
  }
  return finals;
}
