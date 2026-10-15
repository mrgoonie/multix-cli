/**
 * Shared submit → (wait) → report flow for `runway video|image|status`.
 * A created task always prints its id with the commands to check, resume
 * and cancel it, so a paid task is never lost when the CLI stops waiting.
 */

import { type Command, InvalidArgumentError } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { type RunwayClient, assertSucceeded } from "../client.js";
import { formatCredits } from "../models.js";
import { saveTaskOutputs } from "../node-outputs.js";
import { summarizeTask } from "../output.js";
import type { RunwayCreatedTask, RunwayTask } from "../types.js";

export interface WaitFlags {
  waitTimeout: string;
  /** undefined (no flag) means the command default. */
  download?: boolean;
  output?: string;
  json?: boolean;
  verbose?: boolean;
}

export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new ValidationError(`${flag} must be a positive integer`);
  return n;
}

/** Commander collector for repeatable options. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Commander parser that rejects an empty value early (e.g. `--ratio ""`). */
export function nonEmpty(value: string): string {
  if (!value.trim()) throw new InvalidArgumentError("Value must not be empty.");
  return value.trim();
}

/** Register the download/output/timeout flags shared by video, image and status. */
export function addOutputOptions(cmd: Command, defaultTimeoutMs: number): Command {
  return cmd
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download outputs once the task succeeds")
    .option("--no-download", "Print the (signed) output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--json", "Print a JSON summary on stdout")
    .option("-v, --verbose", "Verbose logging");
}

export function resumeCommand(id: string): string {
  return `multix runway status ${id} --wait --download`;
}

function costLine(created: RunwayCreatedTask): string | undefined {
  if (!created.estimatedCost) return undefined;
  return `Estimated cost: up to ${formatCredits(created.estimatedCost.credits)}; the final billed amount may be lower`;
}

/** Print the resumable handle of a task that was created but not waited for. */
export function printCreatedHandle(created: RunwayCreatedTask, json: boolean | undefined): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          id: created.id,
          status: "SUBMITTED",
          ...(created.estimatedCost ? { estimatedCredits: created.estimatedCost.credits } : {}),
          check: `multix runway status ${created.id}`,
          resume: resumeCommand(created.id),
          cancel: `multix runway cancel ${created.id}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Task submitted: ${created.id}`);
  const cost = costLine(created);
  if (cost) console.log(`  ${cost}`);
  console.log(`  Check:  multix runway status ${created.id}`);
  console.log(`  Resume: ${resumeCommand(created.id)}`);
  console.log(`  Cancel: multix runway cancel ${created.id}`);
}

/** Log the task id and estimate right after creation, before any waiting. */
export function logCreated(created: RunwayCreatedTask, logger: Logger): void {
  logger.info(`Task ${created.id} created`);
  const cost = costLine(created);
  if (cost) logger.info(cost);
}

export interface ReportOptions {
  download: boolean;
  output?: string;
  json?: boolean;
  logger: Logger;
  /** Post-process saved files (e.g. WebP conversion) before they are listed. */
  finalize?: (files: string[]) => string[];
}

/** Download (or list) the outputs of a succeeded task. */
export async function reportSucceeded(task: RunwayTask, opts: ReportOptions): Promise<string[]> {
  const urls = task.output ?? [];
  if (!opts.download) {
    if (opts.json) {
      // Signed URLs are requested explicitly here; they are the only way to reach the files.
      console.log(JSON.stringify({ ...summarizeTask(task), output: urls }, null, 2));
    } else {
      for (const url of urls) console.log(url);
    }
    return [];
  }

  const saved = await saveTaskOutputs(task.id, urls, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Fresh URLs are issued on every read: multix runway status ${task.id} --download`,
  });
  const finals = opts.finalize ? opts.finalize(saved) : saved;
  if (opts.json) {
    console.log(JSON.stringify({ ...summarizeTask(task), files: finals }, null, 2));
  } else {
    if (task.cost) console.log(`Charged: ${formatCredits(task.cost.credits)}`);
    console.log(`\nSaved ${finals.length} file(s) from task ${task.id}:`);
    for (const f of finals) console.log(`  ${f}`);
  }
  return finals;
}

/** Wait for a terminal status, fail loudly unless it succeeded, then report outputs. */
export async function completeTask(
  client: RunwayClient,
  id: string,
  opts: { waitTimeoutMs: number } & ReportOptions,
): Promise<string[]> {
  opts.logger.info(`Waiting for task ${id}...`);
  let lastStatus = "";
  const final = await client.waitForTask(id, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `Resume with: ${resumeCommand(id)}`,
    onPoll: (t, attempt) => {
      if (t.status !== lastStatus) {
        const progress = typeof t.progress === "number" ? ` ${Math.round(t.progress * 100)}%` : "";
        opts.logger.debug(`attempt ${attempt}: ${t.status}${progress}`);
      }
      lastStatus = t.status;
    },
  });
  assertSucceeded(final);
  opts.logger.success(`Task ${final.id} succeeded`);
  return reportSucceeded(final, opts);
}
