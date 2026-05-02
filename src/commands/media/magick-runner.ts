/**
 * Thin execa wrapper around ImageMagick `magick` binary.
 * Replaces Pillow from the Python source — no native module deps.
 */

import { execa, ExecaError } from "execa";
import { ProviderError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";

/** Check that `magick` (ImageMagick 7+) is on PATH. */
export async function assertMagick(): Promise<void> {
  try {
    await execa("magick", ["-version"], { reject: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ValidationError(
        "ImageMagick (magick) not found on PATH.\n" +
        "  Linux: sudo apt-get install imagemagick\n" +
        "  macOS: brew install imagemagick\n" +
        "  Windows: https://imagemagick.org/script/download.php",
      );
    }
    // Some versions exit non-zero on -version but binary exists
  }
}

export interface RunMagickOptions {
  verbose?: boolean;
  logger?: Logger;
}

/** Run `magick` with the given argument array. Throws ProviderError on failure. */
export async function runMagick(args: string[], opts: RunMagickOptions = {}): Promise<void> {
  const { verbose, logger } = opts;
  logger?.debug(`magick ${args.join(" ")}`);

  try {
    const result = await execa("magick", args, { reject: true, all: true });
    if (verbose && result.stderr) logger?.debug(result.stderr);
  } catch (e) {
    const err = e as ExecaError;
    const stderr = (err.stderr ?? err.all ?? "").toString().slice(0, 1000);
    throw new ProviderError(`magick failed: ${stderr}`, "imagemagick");
  }
}
