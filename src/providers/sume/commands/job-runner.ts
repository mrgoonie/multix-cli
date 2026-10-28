/**
 * Sume job lifecycle for the CLI: submit once with an Idempotency-Key, then
 * either exit with the job id (--async) or poll (bounded) to a terminal
 * state, read the job's final usage ledger (the settled charge or refund),
 * and save the artifacts.
 *
 * The generate POST is never retried: a cut-off submit reports the key that
 * finds the original job again, so a rerun cannot pay twice.
 */

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { run, trackInFlight } from "../../../agent/run-state.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { imageFormatOption, noWebpOption } from "../../../core/image-webp-finalize.js";
import type { Logger } from "../../../core/logger.js";
import {
  NOTHING_SUBMITTED,
  exitOnInterrupt,
  parseTimeoutMs,
} from "../../atlascloud/commands/prediction-runner.js";
import {
  type SumeClient,
  assertValidIdempotencyKey,
  isTerminalState,
  jobState,
} from "../client.js";
import { SUME_PROVIDER } from "../models.js";
import type { SumeJob, SumeJobStatus, SumeRouter } from "../types.js";
import { saveArtifacts } from "./outputs.js";

export { NOTHING_SUBMITTED, exitOnInterrupt, parseTimeoutMs };

export interface SumeRunOpts {
  async?: boolean;
  waitTimeout?: string;
  output?: string;
  /** commander `--no-download` sets false. */
  download?: boolean;
  idempotencyKey?: string;
  imageFormat?: string;
  webp?: boolean;
  verbose?: boolean;
}

export function addSumeRunOptions(
  cmd: Command,
  cfg: { waitTimeoutMs: number; images?: boolean },
): Command {
  cmd
    .option(
      "--async",
      "Submit and exit; print the job id (resume with `multix sume status <id> --wait --download`)",
    )
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(cfg.waitTimeoutMs))
    .option("--output <path>", "Output file (one artifact), file stem (several) or directory")
    .option("--no-download", "Do not download artifacts; print their URLs instead")
    .option(
      "--idempotency-key <key>",
      "Idempotency-Key for the submit (default: a new UUID). Resend a cut-off request with the same key to get the original job instead of a second charge",
    );
  if (cfg.images) cmd.addOption(imageFormatOption()).addOption(noWebpOption());
  return cmd.option("-v, --verbose", "Verbose logging");
}

function shellQuote(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The command that resumes a job, keeping the user's `--output`. */
export function resumeCommand(id: string, output?: string): string {
  const base = `multix sume status ${id} --wait --download`;
  return output ? `${base} --output ${shellQuote(output)}` : base;
}

/** What the settled ledger says, for messages; undefined while it is pending. */
function ledgerNote(job: SumeJob | undefined): string | undefined {
  const u = job?.usage_summary;
  if (!u || u.final !== true) return undefined;
  const cents = (n: number | undefined) => (n === undefined ? "?" : `$${(n / 100).toFixed(2)}`);
  return `ledger ${u.status ?? "final"}: captured ${cents(u.captured_usd_cents)}, refunded ${cents(u.refunded_usd_cents)}`;
}

/**
 * Read the whole job once it is terminal: its final `usage_summary` settles the
 * run's cost receipt. Never fatal; without it the receipt stays uncertain.
 */
async function readSettledJob(
  client: SumeClient,
  id: string,
  logger: Logger,
): Promise<SumeJob | undefined> {
  try {
    return await client.getJob(id);
  } catch (e) {
    logger.warn(
      `Could not read job ${id}'s usage ledger (${e instanceof Error ? e.message : String(e)}); the final charge is unknown.`,
    );
    return undefined;
  }
}

export interface DeliverOptions {
  client: SumeClient;
  logger: Logger;
  opts: SumeRunOpts;
  /** False: report the status and stop (status without --download). */
  download: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface DeliverResult {
  job_id: string;
  status: string;
  files: string[];
  urls: string[];
  job?: SumeJob;
}

/**
 * Handle a terminal status: settle the ledger, fail on a failed or canceled
 * job (Sume refunds its reservation), else fetch the result and save or print it.
 */
export async function deliverJob(
  id: string,
  status: SumeJobStatus,
  o: DeliverOptions,
): Promise<DeliverResult> {
  const state = jobState(status);
  const job = await readSettledJob(o.client, id, o.logger);
  const note = ledgerNote(job);
  if (state === "failed" || state === "canceled") {
    const err = status.error ?? job?.error;
    const why = err ? `: ${err.code ?? "error"}${err.message ? ` — ${err.message}` : ""}` : "";
    const refund = note ?? "Sume refunds the reservation of a failed or canceled job";
    run.data = {
      job_id: id,
      status: state,
      files: [],
      ...(job?.usage_summary ? { usage_summary: job.usage_summary } : {}),
    };
    throw new ProviderError(`Sume job ${id} ${state}${why} (${refund}).`, SUME_PROVIDER);
  }
  if (note) o.logger.info(`Job ${id}: ${note}`);
  const result = await o.client.getResult(id);
  const urls = result.artifacts.map((a) => a.url);
  const base = { job_id: id, status: state, ...(job ? { job } : {}) };
  if (!o.download || o.opts.download === false) {
    for (const url of urls) console.log(url);
    run.data = { job_id: id, status: state, artifacts: result.artifacts.length, files: [] };
    return { ...base, files: [], urls };
  }
  const files = await saveArtifacts(result.artifacts, {
    jobId: id,
    output: o.opts.output,
    imageFormat: o.opts.imageFormat,
    webp: o.opts.webp,
    logger: o.logger,
    retry: resumeCommand(id, o.opts.output),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  console.log(`\nSume job ${id}: saved ${files.length} file(s)`);
  for (const f of files) console.log(`  ${f}`);
  run.data = { job_id: id, status: state, files };
  return { ...base, files, urls };
}

/** Poll a submitted (or resumed) job to a terminal status; a signal leaves it running. */
export function waitForTerminal(
  client: SumeClient,
  id: string,
  cfg: {
    timeoutMs: number;
    output?: string;
    logger: Logger;
    exit?: (code: number) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SumeJobStatus> {
  const resume = resumeCommand(id, cfg.output);
  trackInFlight(id, resume);
  return exitOnInterrupt(
    () =>
      client.waitForJob(id, {
        timeoutMs: cfg.timeoutMs,
        resumeHint: `The job keeps running. Resume with: ${resume}`,
        onPoll: (s, n) => cfg.logger.debug(`poll ${n}: ${jobState(s)}`),
        ...(cfg.sleep ? { sleep: cfg.sleep } : {}),
      }),
    {
      message: `Stopped waiting on Sume job ${id}; it keeps running and is billed. Resume with: ${resume}`,
      exit: cfg.exit,
    },
  );
}

export interface SubmitOptions {
  client: SumeClient;
  logger: Logger;
  router: SumeRouter;
  body: Record<string, unknown>;
  opts: SumeRunOpts;
  defaultWaitTimeoutMs: number;
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export function idempotencyKeyFrom(raw: string | undefined): string {
  if (raw === undefined) return randomUUID();
  const key = raw.trim();
  try {
    assertValidIdempotencyKey(key);
  } catch {
    throw new ValidationError(
      "--idempotency-key must be 1-255 printable ASCII characters without spaces",
    );
  }
  return key;
}

/** Submit once, then exit with the id (--async) or wait and deliver. */
export async function submitSumeJob(o: SubmitOptions): Promise<DeliverResult> {
  const { client, logger, opts } = o;
  const timeoutMs = parseTimeoutMs(opts.waitTimeout, o.defaultWaitTimeoutMs);
  const key = idempotencyKeyFrom(opts.idempotencyKey);
  logger.info(`Submitting to ${String(o.body.model)} (Sume ${o.router} router)...`);
  const submitted = await exitOnInterrupt(() => client.submit(o.router, o.body, key), {
    message: `Stopped while submitting to Sume; the job may have been accepted. Resend with --idempotency-key ${key} to get it back without a second charge.`,
    outcome: {
      hint: `The run stopped while the submit was in flight, so Sume may have accepted (and reserved credits for) a job whose id the run never received. Resend the same command with --idempotency-key ${key}: Sume returns the original job instead of charging again.`,
      retryable: false,
    },
    exit: o.exit,
  });
  const id = submitted.job.id;
  const resume = resumeCommand(id, opts.output);
  // From here a stopped run leaves a billed job behind; its id names the operation.
  trackInFlight(id, resume);
  if (submitted.idempotency_hit)
    logger.info(`Sume returned the existing job ${id} for this Idempotency-Key (no new charge).`);
  if (opts.async) {
    console.log(id);
    console.error(`Job submitted. Resume with: ${resume}`);
    run.data = { job_id: id, status: jobState(submitted.job), idempotency_key: key };
    return { job_id: id, status: jobState(submitted.job), files: [], urls: [] };
  }
  logger.info(`Job ${id}: waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  const status =
    isTerminalState(jobState(submitted.job)) || submitted.terminal === true
      ? {
          job_id: id,
          sume_status: jobState(submitted.job),
          terminal: true,
          error: submitted.job.error ?? null,
        }
      : await waitForTerminal(client, id, {
          timeoutMs,
          output: opts.output,
          logger,
          exit: o.exit,
          sleep: o.sleep,
        });
  return deliverJob(id, status, { client, logger, opts, download: true, fetch: o.fetch });
}
