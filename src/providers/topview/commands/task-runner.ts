/**
 * Shared TopView task lifecycle for CLI commands: submit once -> (async exit |
 * bounded poll) -> terminal check -> download. File names are deterministic
 * per task (`topview-<task id>-NN.<ext>`), so a resumed run keeps the files an
 * earlier run saved and downloads only the missing ones.
 *
 * Downloads are https-only and never reach a local or private address (checked
 * on every redirect hop), capped at MULTIX_MAX_DOWNLOAD_MB.
 */

import path from "node:path";
import type { Command } from "commander";
import { run, trackInFlight } from "../../../agent/run-state.js";
import { ProviderError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { checkUrlSafety } from "../../../core/url-safety.js";
import { downloadClaimed, savedOutput } from "../../atlascloud/commands/output-claims.js";
import {
  NOTHING_SUBMITTED,
  exitOnInterrupt,
  isDirectoryOutput,
  namingPolicy,
  parseTimeoutMs,
} from "../../atlascloud/commands/prediction-runner.js";
import { extensionForContentType, outputExtension } from "../../atlascloud/prediction-output.js";
import { type TopviewLegacyClient, TopviewTaskFailedError } from "../legacy-client.js";
import type { LegacyTaskKind, PlatformRoute } from "../models.js";
import { TOPVIEW_PROVIDER } from "../models.js";
import { type TopviewPlatformClient, TopviewPlatformFailedError } from "../platform-client.js";
import {
  type TaskOutputs,
  legacyCredits,
  legacyOutputs,
  platformChargedUsd,
  platformOutputs,
} from "../task-output.js";
import type { LegacyTask, PlatformPrediction } from "../types.js";

export { NOTHING_SUBMITTED, exitOnInterrupt, parseTimeoutMs };

export interface TaskCliOpts {
  async?: boolean;
  waitTimeout?: string;
  output?: string;
  /** commander `--no-download` sets false. */
  download?: boolean;
  verbose?: boolean;
}

/** Add the lifecycle flags shared by every task command. */
export function addTaskOptions(cmd: Command, waitTimeoutMs: number): Command {
  return cmd
    .option("--async", "Submit and exit; print the task id (resume with `topview status`)")
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(waitTimeoutMs))
    .option("--output <path>", "Output file (single output) or directory (path without extension)")
    .option("--no-download", "Do not download results; print their URLs instead")
    .option("-v, --verbose", "Verbose logging");
}

/** `topview status --task` value for a legacy kind (an export is read as its m2v task). */
export function statusKindOf(kind: LegacyTaskKind): string {
  return kind === "m2v-export" ? "m2v" : kind;
}

export function resumeCommand(taskKind: string, id: string, output?: string): string {
  const base = `multix topview status ${id} --task ${taskKind} --download`;
  return output ? `${base} --output ${shellQuote(output)}` : base;
}

function shellQuote(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function submittedOutcome(what: string): { hint: string; retryable: boolean } {
  return {
    hint: `The run stopped while the ${what} submit was in flight, so TopView may have accepted (and will bill) a task whose id the run never received. Check the task list before resubmitting, or you may pay twice.`,
    retryable: false,
  };
}

/** Report the credits a legacy task says it consumed (topview.ai plan credits, not USD). */
function noteLegacyCredits(task: LegacyTask, logger: Logger): void {
  const credits = legacyCredits(task);
  if (credits !== undefined) logger.info(`Credits used: ${credits} (topview.ai plan credits)`);
}

/**
 * Record a settled Platform charge as usage. `charged_usd` is a decimal string
 * the generic extractor skips; keyed per task so repeated reads replace it.
 */
export function recordPlatformCharge(prediction: PlatformPrediction, logger?: Logger): void {
  const usd = platformChargedUsd(prediction);
  if (usd === undefined) return;
  run.getUsage.set(`topview-platform:prediction:${prediction.id}`, {
    tokens: {},
    metrics: {},
    ids: [prediction.id],
    cost_usd: usd,
    sources: { cost_usd: "platform-backend.topview.ai body.data.charged_usd" },
  });
  logger?.info(`Charged: $${prediction.charged_usd} (${prediction.billing_state})`);
}

export interface LegacyRun {
  client: TopviewLegacyClient;
  logger: Logger;
  kind: LegacyTaskKind;
  body: Record<string, unknown>;
  opts: TaskCliOpts;
  defaultWaitMs: number;
  pollIntervalMs?: number;
  hint: "video" | "image";
  exit?: (code: number) => void;
}

export interface TaskResult {
  taskId: string;
  status?: string;
  files: string[];
  urls: string[];
}

/** Submit a legacy task, then exit with its id (--async) or wait and deliver. */
export async function runLegacyTask(o: LegacyRun): Promise<TaskResult> {
  const { client, logger, opts } = o;
  const timeoutMs = parseTimeoutMs(opts.waitTimeout, o.defaultWaitMs);
  logger.info(`Submitting TopView ${o.kind} task...`);
  const taskId = await exitOnInterrupt(() => client.submit(o.kind, o.body), {
    message: `Cancelled while submitting the ${o.kind} task; TopView may already have accepted it.`,
    outcome: submittedOutcome(o.kind),
    exit: o.exit,
  });
  const resume = resumeCommand(statusKindOf(o.kind), taskId, opts.output);
  if (opts.async) {
    console.log(taskId);
    console.error(`Task submitted. Resume with: ${resume}`);
    run.data = { provider: TOPVIEW_PROVIDER, api: "legacy", task_id: taskId, status: "submitted" };
    return { taskId, files: [], urls: [] };
  }
  trackInFlight(taskId, resume);
  logger.info(`Task ${taskId} — waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  const task = await exitOnInterrupt(
    () =>
      client.waitForTask(o.kind, taskId, {
        timeoutMs,
        intervalMs: o.pollIntervalMs,
        resumeHint: `Resume with: ${resume}`,
        onPoll: (t, n) => logger.debug(`poll ${n}: ${t.status}`),
      }),
    {
      message: `Cancelled while waiting on task ${taskId}; it keeps running and is billed. Resume with: ${resume}`,
      exit: o.exit,
    },
  );
  return finishLegacyTask(o.kind, task, { logger, opts, taskId, hint: o.hint });
}

/** Check a terminal legacy task and deliver its results. */
export async function finishLegacyTask(
  kind: LegacyTaskKind,
  task: LegacyTask,
  cfg: { logger: Logger; opts: TaskCliOpts; taskId: string; hint: "video" | "image" },
): Promise<TaskResult> {
  if (task.status === "fail") throw new TopviewTaskFailedError(task);
  if (task.status !== "success") {
    throw new ProviderError(
      `TopView task ${cfg.taskId} is not finished (status "${task.status}")`,
      TOPVIEW_PROVIDER,
    );
  }
  noteLegacyCredits(task, cfg.logger);
  const outputs = legacyOutputs(kind, task);
  const resume = resumeCommand(statusKindOf(kind), cfg.taskId, cfg.opts.output);
  const delivered = await deliverOutputs(outputs, { ...cfg, resume });
  run.data = {
    provider: TOPVIEW_PROVIDER,
    api: "legacy",
    task_id: cfg.taskId,
    status: task.status,
    credits: legacyCredits(task) ?? null,
    files: delivered.files,
  };
  return { taskId: cfg.taskId, status: task.status, ...delivered };
}

export interface PlatformRun {
  client: TopviewPlatformClient;
  logger: Logger;
  route: PlatformRoute;
  body: Record<string, unknown>;
  idempotencyKey: string;
  opts: TaskCliOpts;
  defaultWaitMs: number;
  pollIntervalMs?: number;
  exit?: (code: number) => void;
}

/** Create a Platform prediction, then exit with its id (--async) or wait and deliver. */
export async function runPlatformTask(o: PlatformRun): Promise<TaskResult> {
  const { client, logger, opts } = o;
  const timeoutMs = parseTimeoutMs(opts.waitTimeout, o.defaultWaitMs);
  const what = `${o.route.owner}/${o.route.model}/${o.route.mode}`;
  logger.info(`Submitting to ${what} (Idempotency-Key ${o.idempotencyKey})...`);
  const created = await exitOnInterrupt(
    () => client.createPrediction(o.route, o.body, o.idempotencyKey),
    {
      message: `Cancelled while submitting to ${what}; the Platform may already have accepted it. Resend with --idempotency-key ${o.idempotencyKey} to get the same task back.`,
      outcome: submittedOutcome(what),
      exit: o.exit,
    },
  );
  const id = created.id;
  const resume = resumeCommand("platform", id, opts.output);
  if (opts.async) {
    console.log(id);
    console.error(`Task submitted. Resume with: ${resume}`);
    run.data = { provider: TOPVIEW_PROVIDER, api: "platform", task_id: id, status: created.status };
    return { taskId: id, status: created.status, files: [], urls: [] };
  }
  trackInFlight(id, resume);
  logger.info(`Task ${id} — waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  let paymentWarned = false;
  const final = await exitOnInterrupt(
    () =>
      client.waitForPrediction(id, {
        timeoutMs,
        intervalMs: o.pollIntervalMs,
        resumeHint: `Resume with: ${resume}`,
        onPoll: (p, n) => {
          logger.debug(`poll ${n}: ${p.status}`);
          if (p.status === "payment_required" && !paymentWarned) {
            paymentWarned = true;
            logger.warn(
              `Task ${id} needs payment (shortfall $${p.shortfall_usd ?? "?"}): top up the Platform workspace; it settles without resubmitting.`,
            );
          }
        },
      }),
    {
      message: `Cancelled while waiting on task ${id}; it keeps running and is billed. Resume with: ${resume}`,
      exit: o.exit,
    },
  );
  return finishPlatformTask(final, { logger, opts, taskId: id, hint: o.route.output });
}

export async function finishPlatformTask(
  prediction: PlatformPrediction,
  cfg: { logger: Logger; opts: TaskCliOpts; taskId: string; hint: "video" | "image" },
): Promise<TaskResult> {
  recordPlatformCharge(prediction, cfg.logger);
  if (prediction.status === "failed") throw new TopviewPlatformFailedError(prediction);
  if (prediction.status !== "completed") {
    throw new ProviderError(
      `TopView Platform task ${cfg.taskId} is not finished (status "${prediction.status}")`,
      TOPVIEW_PROVIDER,
    );
  }
  const resume = resumeCommand("platform", cfg.taskId, cfg.opts.output);
  const delivered = await deliverOutputs(platformOutputs(prediction), { ...cfg, resume });
  run.data = {
    provider: TOPVIEW_PROVIDER,
    api: "platform",
    task_id: cfg.taskId,
    status: prediction.status,
    charged_usd: prediction.charged_usd ?? null,
    billing_state: prediction.billing_state ?? null,
    files: delivered.files,
  };
  return { taskId: cfg.taskId, status: prediction.status, ...delivered };
}

function checkOutputUrl(url: string): void {
  checkUrlSafety(url, { provider: TOPVIEW_PROVIDER });
}

/** `topview-<task id>-NN.<ext>`: task ids are validated as [A-Za-z0-9_-]{1,128}. */
export function outputFileName(taskId: string, index: number, ext: string): string {
  return `topview-${taskId}-${String(index + 1).padStart(2, "0")}.${ext}`;
}

/** Local paths for the outputs, following the same `--output` rules as Atlas. */
export function planOutputPaths(
  urls: string[],
  cfg: { taskId: string; output?: string; hint: "video" | "image"; outDir?: () => string },
): string[] {
  const fallback = cfg.hint === "video" ? "mp4" : "png";
  const exts = urls.map((u) => outputExtension(u) ?? fallback);
  if (!cfg.output || isDirectoryOutput(cfg.output)) {
    const dir = cfg.output ? path.resolve(cfg.output) : (cfg.outDir ?? getOutputDir)();
    return exts.map((ext, i) => path.join(dir, outputFileName(cfg.taskId, i, ext)));
  }
  const abs = path.resolve(cfg.output);
  if (urls.length === 1) return [abs];
  const base = abs.slice(0, -path.extname(abs).length);
  return exts.map((ext, i) => `${base}-${String(i + 1).padStart(2, "0")}.${ext}`);
}

/** Download every https output; a partial download exits non-zero with the resume command. */
export async function deliverOutputs(
  outputs: TaskOutputs,
  cfg: {
    logger: Logger;
    opts: TaskCliOpts;
    taskId: string;
    hint: "video" | "image";
    resume: string;
  },
): Promise<{ files: string[]; urls: string[] }> {
  const { logger, opts, taskId } = cfg;
  if (outputs.skipped > 0) {
    logger.warn(
      `${outputs.skipped} output(s) are not https URLs (e.g. Base64 data) and were not saved.`,
    );
  }
  if (outputs.urls.length === 0) {
    throw new ProviderError(
      `TopView task ${taskId} finished but returned no result URLs.`,
      TOPVIEW_PROVIDER,
    );
  }
  if (opts.download === false) {
    for (const u of outputs.urls) console.log(u);
    return { files: [], urls: outputs.urls };
  }
  const dests = planOutputPaths(outputs.urls, { taskId, output: opts.output, hint: cfg.hint });
  const policy = namingPolicy(opts.output, outputs.urls.length);
  const maxBytes = maxDownloadBytes();
  const files: string[] = [];
  let failed = 0;
  for (let i = 0; i < outputs.urls.length; i++) {
    const url = outputs.urls[i] as string;
    const planned = dests[i] as string;
    try {
      const existing = policy === "reuse" ? savedOutput(planned) : undefined;
      if (existing) {
        files.push(existing);
        logger.info(`Already saved: ${existing}`);
        continue;
      }
      const dest = await downloadClaimed(
        url,
        (response) =>
          policy === "overwrite" || outputExtension(url)
            ? planned
            : withContentTypeExtension(planned, response.headers.get("content-type")),
        policy,
        { maxBytes, validateUrl: checkOutputUrl },
      );
      files.push(dest);
      logger.debug(`Downloaded ${redactUrl(url)} -> ${dest}`);
    } catch (e) {
      failed++;
      logger.warn(
        `Download failed (${redactUrl(url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (files.length === 0) {
    throw new ProviderError(
      `TopView task ${taskId} produced ${outputs.urls.length} result(s) but none downloaded. Retry with: ${cfg.resume}`,
      TOPVIEW_PROVIDER,
    );
  }
  console.log(`\nTask ${taskId}: saved ${files.length} file(s)`);
  for (const f of files) console.log(`  ${f}`);
  if (failed > 0) {
    throw new ProviderError(
      `TopView task ${taskId}: downloaded ${files.length} of ${outputs.urls.length} result(s); ${failed} failed. Retry with: ${cfg.resume}`,
      TOPVIEW_PROVIDER,
    );
  }
  return { files, urls: outputs.urls };
}

function withContentTypeExtension(planned: string, contentType: string | null): string {
  const ext = extensionForContentType(contentType);
  if (!ext) return planned;
  const current = path.extname(planned);
  return `${current ? planned.slice(0, -current.length) : planned}.${ext}`;
}
