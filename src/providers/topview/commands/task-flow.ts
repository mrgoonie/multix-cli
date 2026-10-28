/**
 * Shared submit → (wait) → report flow for `topview` commands.
 *
 * stdout carries only the result: the task id after a submit, the saved file
 * list, or a JSON summary. Progress, costs and Check/Resume hints go to
 * stderr. Output URLs are signed, so summaries print them without query
 * strings; only an explicit `--no-download` prints the raw URLs.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { type TopviewClient, assertTaskSucceeded } from "../client.js";
import type { LegacyKind } from "../models.js";
import { saveOutputs } from "../node-outputs.js";
import { type TopviewPlatformClient, assertPredictionCompleted } from "../platform-client.js";
import type { LegacyTask, Prediction } from "../types.js";

export interface WaitFlagOptions {
  wait?: boolean;
  waitTimeout: string;
  /** undefined (no flag) and true both mean "download". */
  download?: boolean;
  output?: string;
  verbose?: boolean;
}

/** Register --wait, --wait-timeout, --download/--no-download, --output and -v. */
export function addOutputOptions(cmd: Command, defaultTimeoutMs: number): Command {
  return cmd
    .option("--wait", "Wait for the task to finish, then download the outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download outputs once the task succeeds (default when waiting)")
    .option("--no-download", "Print output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("-v, --verbose", "Verbose logging");
}

/** --output and --download/--no-download only make sense with --wait. */
export function checkWaitFlags(opts: WaitFlagOptions, statusKind: string): number {
  if (!opts.wait && (opts.output !== undefined || opts.download !== undefined)) {
    throw new ValidationError(
      `--output and --download/--no-download need --wait (or use \`multix topview status ${statusKind} <id> --wait --download\` later)`,
    );
  }
  return parsePositiveInt(opts.waitTimeout, "--wait-timeout");
}

export function parsePositiveInt(raw: string, flag: string, max?: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || n <= 0 || (max !== undefined && n > max)) {
    throw new ValidationError(
      `${flag} must be a positive integer${max !== undefined ? ` up to ${max}` : ""}`,
    );
  }
  return n;
}

/** Status kind for a legacy task kind (url-to-video and materials-to-video share m2v). */
export function resumeCommand(kind: LegacyKind | "platform", id: string): string {
  return `multix topview status ${kind} ${id} --wait --download`;
}

/** stdout: the task id; stderr: how to check and resume it. TopView offers no cancel. */
export function printTaskHandle(kind: LegacyKind | "platform", id: string): void {
  console.log(id);
  console.error(`Task submitted: ${id}`);
  console.error(`  Check:  multix topview status ${kind} ${id}`);
  console.error(`  Resume: ${resumeCommand(kind, id)}`);
}

const redactAll = (urls: string[]) => urls.map((u) => redactUrl(u));

/** Printable view of a legacy task: no inputs, and URLs without query strings. */
export function summarizeLegacyTask(task: LegacyTask): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    kind: task.kind,
    taskId: task.taskId,
    status: task.status,
  };
  if (task.errorMsg) summary.errorMsg = task.errorMsg;
  if (task.costCredit !== undefined) summary.costCredit = task.costCredit;
  if (task.bgRemovedImageFileId) summary.bgRemovedImageFileId = task.bgRemovedImageFileId;
  if (task.maskImageFileId) summary.maskImageFileId = task.maskImageFileId;
  const videos = (list: LegacyTask["previewVideos"]) =>
    list?.map((v) => ({ ...v, ...(v.videoUrl ? { videoUrl: redactUrl(v.videoUrl) } : {}) }));
  if (task.previewVideos) summary.previewVideos = videos(task.previewVideos);
  if (task.exportVideos) summary.exportVideos = videos(task.exportVideos);
  if (task.images) {
    summary.images = task.images.map((i) => ({
      ...i,
      ...(i.url ? { url: redactUrl(i.url) } : {}),
    }));
  }
  if (task.outputs.length > 0) summary.outputs = redactAll(task.outputs);
  return summary;
}

/** Printable view of a prediction: URLs without query strings. */
export function summarizePrediction(prediction: Prediction): Record<string, unknown> {
  const { outputs, ...rest } = prediction;
  return { ...rest, ...(outputs.length > 0 ? { outputs: redactAll(outputs) } : {}) };
}

export interface ReportOptions {
  download: boolean;
  /** Print the signed output URLs as-is (an explicit `--no-download`). */
  rawUrls?: boolean;
  output?: string;
  logger: Logger;
  /** Shown when a download fails, e.g. the status command that refetches fresh URLs. */
  retryHint: string;
}

/** Download (or print) the outputs of a finished task. */
export async function reportOutputs(
  id: string,
  urls: string[],
  summary: Record<string, unknown>,
  opts: ReportOptions,
): Promise<string[]> {
  if (!opts.download) {
    if (opts.rawUrls) for (const url of urls) console.log(url);
    else console.log(JSON.stringify(summary, null, 2));
    return [];
  }
  if (urls.length === 0) {
    opts.logger.warn(`Task ${id} finished without downloadable outputs`);
    console.log(JSON.stringify(summary, null, 2));
    return [];
  }
  const saved = await saveOutputs(id, urls, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: opts.retryHint,
  });
  console.log(`\nSaved ${saved.length} file(s) from task ${id}:`);
  for (const f of saved) console.log(`  ${f}`);
  return saved;
}

export interface CompleteOptions {
  waitTimeoutMs: number;
  logger: Logger;
  download: boolean;
  rawUrls?: boolean;
  output?: string;
}

function logCredits(logger: Logger, task: LegacyTask): void {
  if (task.costCredit !== undefined) logger.info(`Credits charged: ${task.costCredit}`);
}

/** Wait for a legacy task, fail loudly unless it succeeded; returns the final task. */
export async function waitLegacyTask(
  client: TopviewClient,
  kind: LegacyKind,
  id: string,
  opts: {
    waitTimeoutMs: number;
    logger: Logger;
    isDone?: (t: LegacyTask) => boolean;
    /** Decide success from the final task (an m2v export succeeds by its export entry). */
    judge?: (t: LegacyTask) => LegacyTask;
  },
): Promise<LegacyTask> {
  opts.logger.info(`Waiting for TopView ${kind} task ${id} (polling every 3-5s)...`);
  let last = "";
  const task = await client.waitForTask(kind, id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `Resume with: ${resumeCommand(kind, id)}`,
    isDone: opts.isDone,
    onPoll: (t, attempt) => {
      if (t.status !== last) opts.logger.debug(`attempt ${attempt}: ${t.status}`);
      last = t.status;
    },
  });
  logCredits(opts.logger, task);
  return assertTaskSucceeded(opts.judge ? opts.judge(task) : task);
}

/** Wait, then download or print the outputs of a legacy task. */
export async function completeLegacyTask(
  client: TopviewClient,
  kind: LegacyKind,
  id: string,
  opts: CompleteOptions & {
    isDone?: (t: LegacyTask) => boolean;
    judge?: (t: LegacyTask) => LegacyTask;
    outputs?: (t: LegacyTask) => string[];
  },
): Promise<LegacyTask> {
  const task = await waitLegacyTask(client, kind, id, opts);
  opts.logger.success(`TopView ${kind} task ${id} succeeded`);
  await reportOutputs(
    id,
    opts.outputs ? opts.outputs(task) : task.outputs,
    summarizeLegacyTask(task),
    {
      ...opts,
      retryHint: `Fetch fresh URLs and retry: multix topview status ${kind} ${id} --download`,
    },
  );
  return task;
}

/** Log what TopView charged for a prediction (USD, exact decimal) and the billing state. */
export function logCharge(logger: Logger, prediction: Prediction): void {
  if (prediction.chargedUsd !== undefined || prediction.billingState) {
    const charged = prediction.chargedUsd !== undefined ? `$${prediction.chargedUsd}` : "unknown";
    const state = prediction.billingState ? ` (billing ${prediction.billingState})` : "";
    logger.info(`Charged: ${charged}${state}`);
  }
}

/** Wait for a prediction, fail loudly unless completed, then report its outputs. */
export async function completePrediction(
  client: TopviewPlatformClient,
  id: string,
  opts: CompleteOptions,
): Promise<Prediction> {
  opts.logger.info(`Waiting for TopView prediction ${id} (polling every 2-5s)...`);
  let last = "";
  const prediction = await client.waitForPrediction(id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `A timeout is not a failure; do not resubmit. Resume with: ${resumeCommand("platform", id)}`,
    onPoll: (p, attempt) => {
      if (p.status !== last) opts.logger.debug(`attempt ${attempt}: ${p.status}`);
      last = p.status;
    },
  });
  logCharge(opts.logger, prediction);
  if (prediction.status === "payment_required") {
    opts.logger.warn(`After topping up, resume with: ${resumeCommand("platform", id)}`);
  }
  assertPredictionCompleted(prediction);
  opts.logger.success(`TopView prediction ${id} completed`);
  await reportOutputs(id, prediction.outputs, summarizePrediction(prediction), {
    ...opts,
    retryHint: `Fetch fresh URLs and retry: multix topview status platform ${id} --download`,
  });
  return prediction;
}
