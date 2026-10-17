/**
 * Shared submit → (wait) → report flow for `runway video|image|status`.
 * Output URLs are signed, so summaries print them without query strings;
 * only an explicit `--no-download` prints the raw URLs.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { type RunwayClient, assertSucceeded } from "../client.js";
import { RUNWAY_PRICING_LINK, formatCredits, isTerminalStatus } from "../models.js";
import { saveTaskOutputs } from "../node-outputs.js";
import type { RunwayCreatedTask, RunwayTask } from "../types.js";

export interface WaitFlagOptions {
  waitTimeout: string;
  /** undefined (no flag) and true both mean "download". */
  download?: boolean;
  output?: string;
  verbose?: boolean;
}

/** Register --wait-timeout, --download/--no-download, --output and -v. */
export function addOutputOptions(cmd: Command, defaultTimeoutMs: number): Command {
  return cmd
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download outputs once the task succeeds (default when waiting)")
    .option("--no-download", "Print output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("-v, --verbose", "Verbose logging");
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

export function resumeCommand(id: string): string {
  return `multix runway status ${id} --wait --download`;
}

export function printTaskHandle(id: string): void {
  console.log(`Task submitted: ${id}`);
  console.log(`  Check:  multix runway status ${id}`);
  console.log(`  Resume: ${resumeCommand(id)}`);
  console.log(`  Cancel: multix runway cancel ${id}`);
}

/** Printable view of a task: no prompt or inputs, and output URLs without query strings. */
export function summarizeTask(task: RunwayTask): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: task.id, status: task.status };
  if (task.createdAt) summary.createdAt = task.createdAt;
  if (typeof task.progress === "number") summary.progress = task.progress;
  if (task.estimatedCost) summary.estimatedCost = task.estimatedCost;
  if (task.cost) summary.cost = task.cost;
  if (task.failure) summary.failure = task.failure;
  if (task.failureCode) summary.failureCode = task.failureCode;
  if (task.output) summary.output = task.output.map((u) => redactUrl(u));
  return summary;
}

export function logEstimate(logger: Logger, credits: number, approximate: boolean): void {
  logger.info(
    `Indicative cost: ${approximate ? "from " : ""}${formatCredits(credits)} at list price; Runway reports the actual amount (${RUNWAY_PRICING_LINK})`,
  );
}

export function logCreated(logger: Logger, created: RunwayCreatedTask): void {
  const max = created.estimatedCost
    ? `; Runway estimate: up to ${formatCredits(created.estimatedCost.credits)}`
    : "";
  logger.success(`Created Runway task ${created.id}${max}`);
}

export interface ReportOptions {
  download: boolean;
  /**
   * Without download, print the signed output URLs as-is (an explicit
   * `--no-download`) instead of the summary with query strings removed.
   */
  rawUrls?: boolean;
  output?: string;
  /** After a download, print the summary plus saved file paths as JSON. */
  json?: boolean;
  logger: Logger;
  /** Post-process saved files (e.g. WebP conversion) before they are listed. */
  finalize?: (files: string[]) => string[];
}

/** Download (or print) the outputs of a succeeded task. */
export async function reportOutputs(task: RunwayTask, opts: ReportOptions): Promise<string[]> {
  const urls = task.output ?? [];
  if (task.cost) opts.logger.info(`Billed: ${formatCredits(task.cost.credits)}`);
  if (!opts.download) {
    if (opts.rawUrls) for (const url of urls) console.log(url);
    else console.log(JSON.stringify(summarizeTask(task), null, 2));
    return [];
  }
  const saved = await saveTaskOutputs(task.id, urls, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Retry while the output URLs are live (24-48h): multix runway status ${task.id} --download`,
  });
  const finals = opts.finalize ? opts.finalize(saved) : saved;
  if (opts.json) {
    console.log(JSON.stringify({ ...summarizeTask(task), files: finals }, null, 2));
    return finals;
  }
  console.log(`\nSaved ${finals.length} file(s) from task ${task.id}:`);
  for (const f of finals) console.log(`  ${f}`);
  return finals;
}

/** Wait for a terminal status, fail loudly unless it succeeded, then report outputs. */
export async function completeTask(
  client: RunwayClient,
  id: string,
  opts: { waitTimeoutMs: number; logger: Logger } & Omit<ReportOptions, "logger">,
): Promise<string[]> {
  opts.logger.info(`Waiting for task ${id} (polling every 5s or more)...`);
  let lastStatus = "";
  const final = await client.waitForTask(id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `Resume with: ${resumeCommand(id)}`,
    onPoll: (task, attempt) => {
      const progress =
        typeof task.progress === "number" ? ` ${Math.round(task.progress * 100)}%` : "";
      if (task.status !== lastStatus || progress) {
        opts.logger.debug(`attempt ${attempt}: ${task.status}${progress}`);
      }
      lastStatus = task.status;
    },
  });
  if (isTerminalStatus(final.status) && final.status !== "SUCCEEDED" && final.cost) {
    opts.logger.info(`Billed: ${formatCredits(final.cost.credits)}`);
  }
  assertSucceeded(final);
  opts.logger.success(`Task ${final.id} succeeded`);
  return reportOutputs(final, opts);
}
