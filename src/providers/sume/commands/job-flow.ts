/**
 * Shared submit → (wait) → report flow for `multix sume image|video|status`.
 * stdout carries only the result (the job handle, a JSON summary, or the
 * saved file list); progress, charges and hints go to stderr.
 */

import type { Command } from "commander";
import { run, trackInFlight } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import type { SumeClient } from "../client.js";
import { SumeJobFailedError } from "../errors.js";
import { formatCents } from "../models.js";
import { saveArtifacts } from "../node-outputs.js";
import type { SumeArtifact, SumeJob, SumeSubmitted } from "../types.js";

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
    .option("--download", "Download artifacts once the job completes (default when waiting)")
    .option("--no-download", "Print artifact URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple artifacts")
    .option("-v, --verbose", "Verbose logging");
}

export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n <= 0) {
    throw new ValidationError(`${flag} must be a positive integer`);
  }
  return n;
}

export function resumeCommand(id: string): string {
  return `multix sume status ${id} --wait --download`;
}

export function printJobHandle(id: string): void {
  console.log(`Job submitted: ${id}`);
  console.log(`  Check:  multix sume status ${id}`);
  console.log(`  Resume: ${resumeCommand(id)}`);
  console.log(`  Cancel: multix sume cancel ${id}`);
}

/** POSIX-shell quoting for a printed command. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The command that resubmits this run with the same idempotency key, so Sume
 * returns the job it may already have accepted instead of charging again.
 */
export function retryWithKeyCommand(fallback: string, key: string): string {
  const argv: string[] = [];
  for (let i = 0; i < run.argv.length; i++) {
    const arg = run.argv[i] ?? "";
    if (arg === "--idempotency-key") {
      i++;
      continue;
    }
    if (arg.startsWith("--idempotency-key=")) continue;
    argv.push(arg);
  }
  const base = argv.length > 0 ? `multix ${argv.map(quote).join(" ")}` : fallback;
  return `${base} --idempotency-key ${quote(key)}`;
}

/** Printable view of a job: no prompt or inputs. */
export function summarizeJob(job: SumeJob): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: job.id, status: job.status };
  if (job.model) summary.model = job.model;
  if (job.createdAt) summary.created_at = job.createdAt;
  if (job.cancelable !== undefined) summary.cancelable = job.cancelable;
  if (job.queuePosition !== undefined) summary.queue_position = job.queuePosition;
  if (job.error) summary.error = job.error;
  if (job.usageSummary) summary.usage_summary = job.usageSummary;
  return summary;
}

/** Log what the submit charged (Sume reserves the price at submit). */
export function logSubmitted(logger: Logger, submitted: SumeSubmitted): void {
  const { job } = submitted;
  if (submitted.idempotencyHit) {
    logger.info(
      `idempotency_hit: true — Sume matched key ${submitted.idempotencyKey} to job ${job.id} it already accepted; it is not charged again`,
    );
  }
  const charge =
    submitted.usageUsd && !submitted.idempotencyHit
      ? `; charged $${submitted.usageUsd} (refunded if the job fails or is canceled)`
      : "";
  logger.success(`Submitted Sume job ${job.id} (${job.status})${charge}`);
}

/** Log the settled charge or refund from a job's usage_summary. */
export function logSettlement(logger: Logger, job: SumeJob): void {
  const u = job.usageSummary;
  if (!u) return;
  if (u.refunded_usd_cents !== undefined && u.refunded_usd_cents > 0) {
    logger.info(`Refunded: ${formatCents(u.refunded_usd_cents)}`);
  }
  if (u.captured_usd_cents !== undefined && (u.final || u.status === "captured")) {
    logger.info(`Charged: ${formatCents(u.captured_usd_cents)}`);
  }
}

export interface ReportOptions {
  download: boolean;
  /** Without download: print the artifact URLs (an explicit --no-download) instead of a JSON summary. */
  rawUrls?: boolean;
  output?: string;
  logger: Logger;
  /** Post-process saved files (e.g. WebP conversion) before they are listed. */
  finalize?: (files: string[]) => string[];
}

/** Download (or print) the artifacts of a completed job. */
export async function reportArtifacts(
  jobId: string,
  artifacts: SumeArtifact[],
  opts: ReportOptions,
): Promise<string[]> {
  if (artifacts.length === 0) {
    throw new SumeJobFailedError({
      id: jobId,
      status: "completed",
      terminal: true,
      error: { message: "the job completed without artifacts" },
    });
  }
  if (!opts.download) {
    if (opts.rawUrls) for (const a of artifacts) console.log(a.url);
    else {
      const view = artifacts.map((a) => ({ ...a, url: redactUrl(a.url) }));
      console.log(JSON.stringify({ id: jobId, status: "completed", artifacts: view }, null, 2));
    }
    return [];
  }
  const saved = await saveArtifacts(jobId, artifacts, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Retry with: multix sume status ${jobId} --download`,
  });
  const finals = opts.finalize ? opts.finalize(saved) : saved;
  console.log(`\nSaved ${finals.length} file(s) from job ${jobId}:`);
  for (const f of finals) console.log(`  ${f}`);
  return finals;
}

/**
 * A failed or canceled job: fetch the full job when the status read did not
 * carry the reason or the refund (best effort), log the refund, then throw.
 */
export async function failJob(client: SumeClient, job: SumeJob, logger: Logger): Promise<never> {
  let final = job;
  if (!job.error || !job.usageSummary) {
    try {
      const full = await client.getJob(job.id);
      final = {
        ...job,
        error: job.error ?? full.error,
        usageSummary: job.usageSummary ?? full.usageSummary,
      };
    } catch (error) {
      logger.debug(
        `Could not read job ${job.id} details: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  logSettlement(logger, final);
  throw new SumeJobFailedError(final);
}

/** Wait for a terminal status, fail loudly unless it completed, then report the artifacts. */
export async function completeJob(
  client: SumeClient,
  id: string,
  opts: { waitTimeoutMs: number; logger: Logger } & Omit<ReportOptions, "logger">,
): Promise<string[]> {
  const resume = resumeCommand(id);
  trackInFlight(id, resume);
  opts.logger.info(`Waiting for Sume job ${id}...`);
  let lastStatus = "";
  const final = await client.waitForJob(id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `The job keeps running on Sume. Resume with: ${resume}`,
    onPoll: (job, attempt) => {
      if (job.status !== lastStatus) {
        const queue =
          job.queuePosition !== undefined ? ` (queue position ${job.queuePosition})` : "";
        opts.logger.debug(`attempt ${attempt}: ${job.status}${queue}`);
      }
      lastStatus = job.status;
    },
  });
  if (final.status !== "completed") return failJob(client, final, opts.logger);
  opts.logger.success(`Sume job ${final.id} completed`);
  logSettlement(opts.logger, final);
  const result = await client.getResult(final.id);
  return reportArtifacts(final.id, result.artifacts, opts);
}
