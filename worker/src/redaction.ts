/**
 * Scrub secrets from text that leaves the Worker (tool errors, logs):
 * configured key values, bearer tokens and URL query strings (signed URLs).
 */

import { redactUrl } from "../../src/core/redact.js";

const URL_RE = /https?:\/\/[^\s"'<>`]+/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_MESSAGE_CHARS = 600;

export function sanitizeText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  out = out.replace(URL_RE, (url) => redactUrl(url));
  out = out.replace(BEARER_RE, "$1 [redacted]");
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS)}…` : out;
}

type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * One structured JSON line per event. Callers pass identifiers and metrics
 * only — never prompts, keys or output URLs.
 */
export function logEvent(level: "info" | "warn" | "error", event: string, fields: LogFields) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
