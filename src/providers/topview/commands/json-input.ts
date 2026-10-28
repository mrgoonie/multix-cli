/**
 * JSON object flags: `--input` (Platform request body) and `--extra` (more
 * documented legacy fields). Inline JSON or `@path` to a JSON file.
 */

import fs from "node:fs";
import { ValidationError } from "../../../core/errors.js";

const MAX_JSON_FILE_BYTES = 1024 * 1024;

export function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  // Only a leading "@" (no trimming) names a file: callers that forbid file
  // references check the raw value the same way.
  let text = raw;
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      throw new ValidationError(`${flag}: file not found: ${file}`);
    }
    if (size > MAX_JSON_FILE_BYTES)
      throw new ValidationError(`${flag}: ${file} is larger than 1 MB`);
    text = fs.readFileSync(file, "utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ValidationError(
      `${flag} must be a JSON object or @file.json (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge `--extra` into a body built from flags. A key the flags already set is
 * refused instead of silently overridden, so the request is what the flags say.
 */
export function mergeExtra(
  body: Record<string, unknown>,
  extra: string | undefined,
): Record<string, unknown> {
  if (extra === undefined) return body;
  const fields = parseJsonObject(extra, "--extra");
  for (const key of Object.keys(fields)) {
    if (body[key] !== undefined) {
      throw new ValidationError(`--extra sets "${key}", which a flag already sets; use the flag`);
    }
  }
  return { ...body, ...fields };
}

/** Drop undefined values so the request carries only what the user set. */
export function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/** Validate a flag against a documented set of values. */
export function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${flag} must be one of ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}
