/**
 * Task output helpers: printable summaries, file names and the download URL
 * policy. Runtime-neutral: no node:* imports.
 */

import { redactUrl } from "../../core/redact.js";
import { type UrlSafetyResult, checkUrlSafety } from "../../core/url-safety.js";
import type { RunwayTask } from "./types.js";

/**
 * Policy for downloading a task output URL (applied to every redirect hop):
 * https only, never localhost or a private/special-purpose IP literal.
 * Messages name the host only, never the signed URL.
 */
export function checkOutputUrl(url: string): UrlSafetyResult {
  return checkUrlSafety(url, { provider: "runway" });
}

/**
 * Printable view of a task. Output URLs are pre-signed, so their query
 * strings are stripped; use --download (or --no-download for the raw URLs)
 * to get the files themselves. Prompts and inputs are never part of a task.
 */
export function summarizeTask(task: RunwayTask): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: task.id, status: task.status };
  if (task.createdAt) summary.createdAt = task.createdAt;
  if (typeof task.progress === "number") summary.progress = task.progress;
  if (task.estimatedCost) summary.estimatedCredits = task.estimatedCost.credits;
  if (task.cost) summary.credits = task.cost.credits;
  if (task.failure) summary.failure = task.failure;
  if (task.failureCode) summary.failureCode = task.failureCode;
  if (task.output) summary.output = task.output.map((u) => redactUrl(u));
  return summary;
}

/**
 * `runway-<first 8 of id>-NN<ext>` — the default saved-output file name.
 * Non-alphanumerics are stripped so an id can never introduce path segments.
 */
export function outputFilename(taskId: string, index: number, ext: string): string {
  const prefix = taskId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "output";
  return `runway-${prefix}-${String(index + 1).padStart(2, "0")}${ext}`;
}
