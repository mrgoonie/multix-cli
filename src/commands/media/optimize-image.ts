/**
 * Optimize an image file using ImageMagick `magick`.
 * Replaces Pillow from media_optimizer.py — no native deps.
 */

import type { Logger } from "../../core/logger.js";
import { assertMagick, runMagick } from "./magick-runner.js";

export interface OptimizeImageOptions {
  input: string;
  output: string;
  maxWidth?: number; // default 1920
  quality?: number; // 1-100, default 85
  verbose?: boolean;
  logger?: Logger;
}

export async function optimizeImage(opts: OptimizeImageOptions): Promise<void> {
  await assertMagick();

  const { input, output, maxWidth = 1920, quality = 85, verbose, logger } = opts;

  // magick input -resize <maxWidth>x> -quality <q> output
  // The ">" suffix in geometry means "only shrink, never enlarge"
  const args = [input, "-resize", `${maxWidth}x>`, "-quality", String(quality), output];

  await runMagick(args, { verbose, logger });
  logger?.success(`Optimized: ${output}`);
}
