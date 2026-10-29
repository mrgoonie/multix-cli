/**
 * Shared submit → (wait) → report flow for the `topview` commands, for both
 * surfaces. Output URLs are presigned, so summaries print them without query
 * strings; only an explicit `--no-download` prints the raw URLs. Prompts,
 * scripts and request bodies are never logged.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { TopviewPredictionError, TopviewTaskError } from "../errors.js";
import { type TopviewLegacyClient, isLegacyTaskDone } from "../legacy-client.js";
import { TOPVIEW_PLATFORM_PRICING_LINK } from "../models.js";
import { saveOutputs } from "../node-outputs.js";
import type { TopviewPlatformClient } from "../platform-client.js";
import type { LegacyTask, LegacyTaskKind, PlatformPrediction } from "../types.js";

export interface WaitFlagOptions {
  wait?: boolean;
  waitTimeout: string;
  /** undefined (no flag) and true both mean "download". */
  download?: boolean;
  output?: string;
  verbose?: boolean;
}

/** Register --wait, --wait-timeout, --download/--no-download, --output and -v. */
export function addWaitOptions(cmd: Command, defaultTimeoutMs: number, waitHelp?: string): Command {
  return cmd
    .option("--wait", waitHelp ?? "Wait for the task to finish, then download the result")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download outputs once the task succeeds (default when waiting)")
    .option("--no-download", "Print output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("-v, --verbose", "Verbose logging");
}

/** --output and --download/--no-download only make sense while waiting. */
export function assertWaitFlags(opts: WaitFlagOptions, statusCommand: string): void {
  if (!opts.wait && (opts.output !== undefined || opts.download !== undefined)) {
    throw new ValidationError(
      `--output and --download/--no-download need --wait (or use \`${statusCommand}\` later)`,
    );
  }
}

export function parsePositiveInt(raw: string, flag: string, max?: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n <= 0 || (max !== undefined && n > max)) {
    throw new ValidationError(
      `${flag} must be a positive integer${max !== undefined ? ` up to ${max}` : ""}`,
    );
  }
  return n;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Throw unless `value` is one of `allowed`. */
export function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  flag: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new ValidationError(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

/** A non-empty free-text or id flag, trimmed. */
export function nonEmpty(value: string | undefined, flag: string, max = 5000): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${flag} must not be empty`);
  if (trimmed.length > max) throw new ValidationError(`${flag} is longer than ${max} characters`);
  return trimmed;
}

/** `location`: four [x, y] normalised vertices, clockwise from the top-left (JSON). */
export function parseLocation(raw: string, flag = "--location"): number[][] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      `${flag} must be JSON like [[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]`,
    );
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => typeof n === "number" && Number.isFinite(n)),
    )
  ) {
    throw new ValidationError(
      `${flag} must be four [x, y] points (normalised, clockwise from the top-left), e.g. [[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]`,
    );
  }
  return value as number[][];
}

// ---------------------------------------------------------------------------
// Legacy API
// ---------------------------------------------------------------------------

export function legacyResumeCommand(kind: LegacyTaskKind, id: string): string {
  return `multix topview status ${kind} ${id} --wait --download`;
}

export function printLegacyHandle(kind: LegacyTaskKind, id: string): void {
  console.log(`Task submitted: ${id}`);
  console.log(`  Check:  multix topview status ${kind} ${id}`);
  console.log(`  Resume: ${legacyResumeCommand(kind, id)}`);
  console.log(
    "  Cancel: not available (the Legacy API has no cancel endpoint; the task runs to completion and is billed)",
  );
}

/** Printable view of a legacy task: no prompts or inputs, URLs without query strings. */
export function summarizeLegacyTask(task: LegacyTask): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    kind: task.kind,
    taskId: task.taskId,
    status: task.status,
  };
  if (task.errorMsg) summary.errorMsg = task.errorMsg;
  if (task.costCredit !== undefined) summary.costCredit = task.costCredit;
  if (task.videos && task.videos.length > 0) {
    summary.videos = task.videos.map((v) => ({
      ...v,
      ...(v.videoUrl ? { videoUrl: redactUrl(v.videoUrl) } : {}),
    }));
  }
  if (task.bgRemovedImageFileId) summary.bgRemovedImageFileId = task.bgRemovedImageFileId;
  if (task.maskImageFileId) summary.maskImageFileId = task.maskImageFileId;
  if (task.replaceResults) {
    summary.replaceResults = task.replaceResults.map((r) => ({
      ...r,
      ...(r.url ? { url: redactUrl(r.url) } : {}),
    }));
  }
  summary.outputs = task.outputs.map((o) => ({ label: o.label, url: redactUrl(o.url) }));
  return summary;
}

/** Log the provider-reported credits; Legacy credits are topview.ai plan credits. */
export function logLegacyCost(logger: Logger, task: LegacyTask): void {
  if (task.costCredit !== undefined) {
    logger.info(`TopView reported cost: ${task.costCredit} credits (Legacy API plan credits)`);
  }
}

/** What to run next after a product-avatar stage, or how to export an m2v preview. */
export function logNextStep(logger: Logger, task: LegacyTask): void {
  if (task.status !== "success") return;
  if (task.kind === "remove-bg" && task.bgRemovedImageFileId) {
    logger.info(
      `Next stage: multix topview product-avatar --bg-removed-file-id ${task.bgRemovedImageFileId} <stage 2 and 3 flags>`,
    );
  } else if (task.kind === "product-avatar-replace" && task.replaceResults?.length) {
    const ids = task.replaceResults.map((r) => r.imageId).join(", ");
    logger.info(
      `Next stage: multix topview product-avatar --replace-image-id <imageId> <stage 3 flags> (imageIds: ${ids})`,
    );
  } else if (task.kind === "m2v" && task.videos?.some((v) => v.type === "preview")) {
    const hasExport = task.videos.some((v) => v.type === "export");
    if (!hasExport) {
      logger.info(
        `Preview videos are ready. Export one as the final video: multix topview m2v-export ${task.taskId} <scriptId>`,
      );
    }
  }
}

export interface ReportOptions {
  download: boolean;
  /** Without download, print the signed URLs as-is (an explicit `--no-download`). */
  rawUrls?: boolean;
  output?: string;
  logger: Logger;
}

/** Download (or print) the outputs of a finished legacy task. */
export async function reportLegacyOutputs(
  task: LegacyTask,
  opts: ReportOptions & { labels?: readonly string[] },
): Promise<string[]> {
  const outputs = opts.labels
    ? task.outputs.filter((o) => opts.labels?.includes(o.label))
    : task.outputs;
  if (!opts.download) {
    if (opts.rawUrls) for (const o of outputs) console.log(o.url);
    else console.log(JSON.stringify(summarizeLegacyTask(task), null, 2));
    return [];
  }
  if (outputs.length === 0) {
    opts.logger.warn(`TopView ${task.kind} task ${task.taskId} reported no downloadable output`);
    console.log(JSON.stringify(summarizeLegacyTask(task), null, 2));
    return [];
  }
  const saved = await saveOutputs(
    task.taskId,
    outputs.map((o) => o.url),
    {
      outDir: opts.output ? "" : getOutputDir(),
      output: opts.output,
      logger: opts.logger,
      retryHint: `Retry while the result URLs are live (7 days): multix topview status ${task.kind} ${task.taskId} --download`,
    },
  );
  console.log(`\nSaved ${saved.length} file(s) from TopView task ${task.taskId}:`);
  for (const f of saved) console.log(`  ${f}`);
  return saved;
}

/** Wait until done, fail loudly unless it succeeded. Does not download. */
export async function waitLegacyTask(
  client: TopviewLegacyClient,
  kind: LegacyTaskKind,
  id: string,
  opts: {
    waitTimeoutMs: number;
    logger: Logger;
    isDone?: (t: LegacyTask) => boolean;
    resumeHint?: string;
  },
): Promise<LegacyTask> {
  opts.logger.info(`Waiting for TopView ${kind} task ${id} (polling every 3s or more)...`);
  let lastStatus = "";
  const final = await client.waitForTask(kind, id, {
    timeoutMs: opts.waitTimeoutMs,
    isDone: opts.isDone ?? isLegacyTaskDone,
    resumeHint: opts.resumeHint ?? `Resume with: ${legacyResumeCommand(kind, id)}`,
    onPoll: (task, attempt) => {
      if (task.status !== lastStatus) opts.logger.debug(`attempt ${attempt}: ${task.status}`);
      lastStatus = task.status;
    },
  });
  logLegacyCost(opts.logger, final);
  if (final.status !== "success") throw new TopviewTaskError(final);
  opts.logger.success(`TopView ${kind} task ${final.taskId} succeeded`);
  return final;
}

/** Wait, then report outputs. */
export async function completeLegacyTask(
  client: TopviewLegacyClient,
  kind: LegacyTaskKind,
  id: string,
  opts: {
    waitTimeoutMs: number;
    isDone?: (t: LegacyTask) => boolean;
    labels?: string[];
  } & ReportOptions,
): Promise<LegacyTask> {
  const final = await waitLegacyTask(client, kind, id, opts);
  await reportLegacyOutputs(final, opts);
  logNextStep(opts.logger, final);
  return final;
}

// ---------------------------------------------------------------------------
// API Platform
// ---------------------------------------------------------------------------

export function predictionResumeCommand(id: string): string {
  return `multix topview prediction ${id} --wait --download`;
}

export function printPredictionHandle(p: PlatformPrediction, idempotencyKey: string): void {
  console.log(`Prediction submitted: ${p.id} (status: ${p.status})`);
  console.log(`  Check:  multix topview prediction ${p.id}`);
  console.log(`  Resume: ${predictionResumeCommand(p.id)}`);
  console.log("  Cancel: not available (the API Platform has no cancel endpoint)");
  console.log(`  Idempotency key: ${idempotencyKey}`);
}

/** Printable view of a prediction: URLs without query strings, inline data collapsed. */
export function summarizePrediction(p: PlatformPrediction): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: p.id, status: p.status };
  for (const key of [
    "created_at",
    "charged_usd",
    "billing_state",
    "amount_due_usd",
    "additional_charge_usd",
    "shortfall_usd",
    "error",
  ] as const) {
    if (p[key] !== undefined && p[key] !== "") summary[key] = p[key];
  }
  summary.outputs = p.outputs.map((o) => redactUrl(o));
  return summary;
}

const BILLING_STATE_NOTE: Record<string, string> = {
  RESERVED: "reserved, not final",
  CAPTURED: "settled",
  RELEASED: "released, not charged",
};

/** Log the provider-reported USD amount with its billing state. */
export function logPlatformCost(logger: Logger, p: PlatformPrediction): void {
  if (p.charged_usd === undefined) return;
  const state = p.billing_state
    ? ` (${p.billing_state}: ${BILLING_STATE_NOTE[p.billing_state] ?? "see the TopView console"})`
    : "";
  logger.info(
    `TopView API Platform charged_usd: $${p.charged_usd}${state}; prices: ${TOPVIEW_PLATFORM_PRICING_LINK}`,
  );
}

/** Download (or print) the outputs of a completed prediction. */
export async function reportPredictionOutputs(
  p: PlatformPrediction,
  opts: ReportOptions,
): Promise<string[]> {
  if (!opts.download) {
    if (opts.rawUrls) for (const url of p.outputs) console.log(url);
    else console.log(JSON.stringify(summarizePrediction(p), null, 2));
    return [];
  }
  if (p.outputs.length === 0) {
    opts.logger.warn(`TopView prediction ${p.id} completed without outputs`);
    console.log(JSON.stringify(summarizePrediction(p), null, 2));
    return [];
  }
  const saved = await saveOutputs(p.id, p.outputs, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Fetch fresh result URLs and retry: multix topview prediction ${p.id} --download`,
  });
  console.log(`\nSaved ${saved.length} file(s) from TopView prediction ${p.id}:`);
  for (const f of saved) console.log(`  ${f}`);
  return saved;
}

/** Wait for completed/failed/payment_required, fail loudly unless completed, then report. */
export async function completePrediction(
  client: TopviewPlatformClient,
  id: string,
  opts: { waitTimeoutMs: number } & ReportOptions,
): Promise<PlatformPrediction> {
  opts.logger.info(`Waiting for TopView prediction ${id} (polling every 2s or more)...`);
  let lastStatus = "";
  const final = await client.waitForPrediction(id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `Resume with: ${predictionResumeCommand(id)} (do not submit again)`,
    onPoll: (p, attempt) => {
      if (p.status !== lastStatus) opts.logger.debug(`attempt ${attempt}: ${p.status}`);
      lastStatus = p.status;
    },
  });
  logPlatformCost(opts.logger, final);
  if (final.status !== "completed") throw new TopviewPredictionError(final);
  opts.logger.success(`TopView prediction ${final.id} completed`);
  await reportPredictionOutputs(final, opts);
  return final;
}
