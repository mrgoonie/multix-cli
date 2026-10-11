/**
 * Parse a CLI `--input` argument as inline JSON or `@path/to/file.json`.
 * Shared by provider "run" commands that forward model-specific payloads.
 */

import fs from "node:fs";
import { ValidationError } from "./errors.js";

export function parseJsonInput(raw: string, flag = "--input"): Record<string, unknown> {
  let text: string;
  if (raw.startsWith("@")) {
    try {
      text = fs.readFileSync(raw.slice(1), "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ValidationError(`Cannot read ${flag} file: ${msg}`);
    }
  } else {
    text = raw;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("input must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`Invalid ${flag} JSON: ${msg}`);
  }
}
