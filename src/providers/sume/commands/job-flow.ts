/**
 * Shared submit → (wait) → report flow for `sume image|video|status`.
 *
 * Paid work is async by default: a submit prints the job id with the
 * status/resume/cancel commands. `--wait` polls to a terminal status and
 * downloads the artifacts. The submit's usage is a reservation (refunded if
 * the job fails or is canceled); the run's spend is the charge Sume captured,
 * read from the job once it completed. Ctrl-C during the submit names the
 * Idempotency-Key that gets the job back without paying twice; Ctrl-C or a
 * timeout while waiting prints the resume command (the job keeps running).
 * The prompt is never logged.
 */

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { run, trackInFlight } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { NOTHING_SUBMITTED, exitOnInterrupt } from "../../atlascloud/commands/prediction-runner.js";
import { parsePositiveInt } from "../../runway/commands/task-flow.js";
import { type SumeClient, SumeJobError, orphanHint } from "../client.js";
import { SUME_PRICING_LINK, assertIdempotencyKey, priceSummary } from "../models.js";
import { requestCatalog } from "../node-catalog.js";
import { createSumeClient, sumeModelFor } from "../node-client.js";
import { resolveMediaInputs } from "../node-inputs.js";
import { saveJobOutputs } from "../node-outputs.js";
import {
  type SumeCommandKind,
  flagsFromOptions,
  planSumeRequest,
  withMedia,
} from "../request-plan.js";
import type { SumeArtifact, SumeJob, SumeJobStatus, SumeModel, SumeSubmitted } from "../types.js";

export { parsePositiveInt };

export interface OutputFlagOptions {
  waitTimeout: string;
  /** undefined (no flag), true (--download) or false (--no-download). */
  download?: boolean;
  output?: string;
  verbose?: boolean;
}

/** Register --wait-timeout, --download/--no-download, --output and -v. */
export function addOutputOptions(cmd: Command, defaultTimeoutMs: number): Command {
  return cmd
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download outputs once the job completes (default when waiting)")
    .option("--no-download", "Print output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("-v, --verbose", "Verbose logging");
}

/** commander collector for repeatable flags. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
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

/** Printable view of a job status (no prompt, no inputs). */
export function summarizeStatus(status: SumeJobStatus, job?: SumeJob): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    job_id: status.jobId,
    status: status.status,
    terminal: status.terminal,
    result_ready: status.resultReady,
    cancelable: status.cancelable,
  };
  if (status.queuePosition !== undefined) summary.queue_position = status.queuePosition;
  if (status.nextPollAfterSeconds !== undefined) {
    summary.next_poll_after_seconds = status.nextPollAfterSeconds;
  }
  if (job?.model) summary.model = job.model;
  if (job?.createdAt) summary.created_at = job.createdAt;
  if (job?.error) summary.error = job.error;
  return summary;
}

/** Artifacts without query strings (URLs are public by link; signed variants stay hidden). */
export function summarizeArtifacts(artifacts: SumeArtifact[]): Record<string, unknown>[] {
  return artifacts.map((a) => ({
    ...(a.id ? { id: a.id } : {}),
    ...(a.type ? { type: a.type } : {}),
    url: redactUrl(a.url),
    ...(a.contentType ? { content_type: a.contentType } : {}),
    ...(a.sizeBytes !== undefined ? { size_bytes: a.sizeBytes } : {}),
  }));
}

export interface ReportOptions {
  /** true: save files; false: print the raw URLs; undefined: print a summary. */
  download: boolean | undefined;
  output?: string;
  logger: Logger;
}

/** Fetch the artifacts of a completed job and save, print or summarize them. */
export async function reportOutputs(
  client: SumeClient,
  id: string,
  opts: ReportOptions,
): Promise<string[]> {
  const artifacts = await client.getResult(id);
  if (opts.download === false) {
    for (const a of artifacts) console.log(a.url);
    return [];
  }
  if (opts.download === undefined) {
    console.log(
      JSON.stringify(
        { job_id: id, status: "completed", artifacts: summarizeArtifacts(artifacts) },
        null,
        2,
      ),
    );
    return [];
  }
  const saved = await saveJobOutputs(id, artifacts, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Retry with: multix sume status ${id} --download`,
  });
  console.log(`\nSaved ${saved.length} file(s) from job ${id}:`);
  for (const f of saved) console.log(`  ${f}`);
  return saved;
}

/** Throw the job's failure (with Sume's reason) for a failed or canceled job. */
export async function failJob(client: SumeClient, status: SumeJobStatus): Promise<never> {
  let job: SumeJob | undefined;
  try {
    job = await client.getJob(status.jobId);
  } catch {
    // The status alone still says the job did not complete.
  }
  throw new SumeJobError(status.jobId, status.status, job?.error);
}

/**
 * Read a completed job's usage_summary so the run records what Sume captured
 * (the submit's usage is only a reservation). Best effort: a failed read
 * leaves the cost unknown and never fails a completed job.
 */
export async function readCapturedCharge(
  client: SumeClient,
  id: string,
  logger: Logger,
): Promise<void> {
  try {
    const charge = (await client.getJob(id)).charge;
    if (charge?.status === "captured" && charge.capturedUsd !== undefined) {
      logger.info(`Sume charged $${charge.capturedUsd.toFixed(2)} for job ${id}`);
    } else if (charge?.status) {
      logger.debug(`Sume charge for job ${id}: ${charge.status}`);
    }
  } catch (error) {
    logger.debug(
      `Could not read the charge of job ${id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Wait for a terminal status, fail loudly unless it completed, then report
 * the artifacts. While waiting, a stopped run reports how to resume the job.
 */
export async function completeJob(
  client: SumeClient,
  id: string,
  opts: { waitTimeoutMs: number; logger: Logger } & ReportOptions,
): Promise<string[]> {
  const resume = resumeCommand(id);
  trackInFlight(id, resume);
  opts.logger.info(`Waiting for job ${id} (up to ${Math.round(opts.waitTimeoutMs / 1000)}s)...`);
  let last = "";
  const final = await exitOnInterrupt(
    () =>
      client.waitForJob(id, {
        timeoutMs: opts.waitTimeoutMs,
        resumeHint: `The job keeps running. Resume with: ${resume}`,
        onPoll: (s, attempt) => {
          if (s.status !== last) opts.logger.debug(`attempt ${attempt}: ${s.status}`);
          last = s.status;
        },
      }),
    {
      message: `Stopped waiting on job ${id}; it keeps running and is billed when it completes. Resume with: ${resume}`,
    },
  );
  if (final.status !== "completed") await failJob(client, final);
  opts.logger.success(`Job ${id} completed`);
  await readCapturedCharge(client, id, opts.logger);
  return reportOutputs(client, id, opts);
}

export interface GenerateOptions extends OutputFlagOptions {
  model?: string;
  wait?: boolean;
  idempotencyKey?: string;
  [flag: string]: unknown;
}

function findModel(models: SumeModel[], id: string): SumeModel {
  const row = models.find((m) => m.id === id);
  if (!row) {
    throw new ValidationError(
      `Sume's catalog does not list model ${id}. List the models with: multix sume models`,
    );
  }
  return row;
}

/** `sume image` / `sume video`: validate everything, then upload, submit and (with --wait) finish. */
export async function runGeneration(
  command: SumeCommandKind,
  prompt: string | undefined,
  opts: GenerateOptions,
  logger: Logger,
): Promise<void> {
  if (!opts.wait && (opts.output !== undefined || opts.download !== undefined)) {
    throw new ValidationError(
      "--output and --download/--no-download need --wait (or use `multix sume status <id> --wait --download` later)",
    );
  }
  const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
  const modelId = sumeModelFor(command, opts.model);
  const idempotencyKey =
    opts.idempotencyKey !== undefined
      ? assertIdempotencyKey(opts.idempotencyKey)
      : `multix-${randomUUID()}`;
  const client = createSumeClient();
  // The submit's usage is a reservation Sume refunds if the job fails or is
  // canceled: the run's spend is the captured charge read once it completes.
  run.postAmountsReserved = true;

  const loaded = await requestCatalog(client, run.dryRun);
  if (loaded.state === "stale") {
    logger.warn(
      `Could not read Sume's catalog (${loaded.error}); checking flags against the cached copy from ${loaded.fetched_at}`,
    );
  }
  const model = findModel(loaded.catalog.models, modelId);
  const plan = planSumeRequest({ command, model, prompt, flags: flagsFromOptions(opts) });

  const urls = await exitOnInterrupt(() => resolveMediaInputs(plan.media, client, logger), {
    message: "Stopped before the job was submitted; nothing was billed.",
    outcome: NOTHING_SUBMITTED,
  });
  const body = withMedia(plan, urls);

  logger.info(
    `Sume ${command}: ${model.id} (list price ${priceSummary(model)}; ${SUME_PRICING_LINK})`,
  );
  const submitted: SumeSubmitted = await exitOnInterrupt(
    () => client.generate(plan.router, body, { idempotencyKey }),
    {
      message: `Stopped while submitting to Sume. ${orphanHint(idempotencyKey)}`,
      outcome: { hint: orphanHint(idempotencyKey), retryable: false },
    },
  );
  const reserved = submitted.usageUsd
    ? `; reserved $${submitted.usageUsd}, charged only if it completes`
    : "";
  const reused = submitted.idempotencyHit
    ? " (the job already created for this idempotency key)"
    : "";
  logger.success(`Created Sume job ${submitted.jobId}${reused}${reserved}`);

  if (!opts.wait) {
    printJobHandle(submitted.jobId);
    return;
  }
  await completeJob(client, submitted.jobId, {
    waitTimeoutMs,
    logger,
    download: opts.download !== false,
    output: opts.output,
  });
}
