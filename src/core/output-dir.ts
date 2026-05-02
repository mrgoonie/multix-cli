/**
 * Output directory management for generated files.
 * Default: ./multix-output/ (override via MULTIX_OUTPUT_DIR env var).
 * Created lazily on first call; memoized thereafter.
 */

import fs from "node:fs";
import path from "node:path";

let cachedOutputDir: string | undefined;

/**
 * Returns the absolute path to the output directory, creating it if needed.
 * Respects MULTIX_OUTPUT_DIR environment variable.
 */
export function getOutputDir(): string {
  if (cachedOutputDir) return cachedOutputDir;

  const dir = process.env.MULTIX_OUTPUT_DIR
    ? path.resolve(process.env.MULTIX_OUTPUT_DIR)
    : path.resolve(process.cwd(), "multix-output");

  fs.mkdirSync(dir, { recursive: true });
  cachedOutputDir = dir;
  return dir;
}

/** Reset memoized dir — for testing only. */
export function _resetOutputDir(): void {
  cachedOutputDir = undefined;
}
