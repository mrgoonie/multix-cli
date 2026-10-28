/**
 * multix sume status <jobId>  — one status read; --wait polls; --download saves
 * multix sume result <jobId>  — save (or with --no-download, print) a finished job's artifacts
 * multix sume cancel <jobId>  — cancel a job that has not started generating
 *
 * Resuming never submits: it reads the job the id names.
 */

import type { Command } from "commander";
import { ProviderError } from "../../../core/errors.js";
import { imageFormatOption, noWebpOption } from "../../../core/image-webp-finalize.js";
import { isTerminalState, jobState } from "../client.js";
import { SUME_PROVIDER } from "../models.js";
import { createSumeClientFromEnv, createSumeLogger } from "./env.js";
import { type SumeRunOpts, deliverJob, parseTimeoutMs, waitForTerminal } from "./job-runner.js";

const STATUS_WAIT_MS = 1_200_000;

interface StatusFlags extends SumeRunOpts {
  wait?: boolean;
}

function addOutputOptions(cmd: Command): Command {
  return cmd
    .option("--output <path>", "Output file (one artifact), file stem (several) or directory")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("-v, --verbose", "Verbose logging");
}

export function registerSumeStatusCommands(parent: Command): void {
  addOutputOptions(
    parent
      .command("status <jobId>")
      .description("Get a Sume job's status; --wait to poll, --download to save its artifacts")
      .option("--wait", "Poll until the job finishes")
      .option("--wait-timeout <ms>", "Max time to wait (with --wait)", String(STATUS_WAIT_MS))
      .option("--download", "Save artifacts when finished (implies --wait)"),
  ).action(async (jobId: string, opts: StatusFlags & { download?: boolean }) => {
    const logger = createSumeLogger({ verbose: opts.verbose, stdoutReserved: true });
    const client = createSumeClientFromEnv();
    const wait = Boolean(opts.wait || opts.download);
    const status = wait
      ? await waitForTerminal(client, jobId, {
          timeoutMs: parseTimeoutMs(opts.waitTimeout, STATUS_WAIT_MS),
          output: opts.output,
          logger,
        })
      : await client.getStatus(jobId);
    const state = jobState(status);
    if (!isTerminalState(state)) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    // Terminal: read the ledger (settles the receipt); without --download the URLs are printed.
    await deliverJob(jobId, status, { client, logger, opts, download: Boolean(opts.download) });
  });

  addOutputOptions(
    parent
      .command("result <jobId>")
      .description("Save a finished Sume job's artifacts (or print their URLs with --no-download)")
      .option("--no-download", "Print artifact URLs instead of saving them"),
  ).action(async (jobId: string, opts: SumeRunOpts) => {
    const logger = createSumeLogger({ verbose: opts.verbose, stdoutReserved: true });
    const client = createSumeClientFromEnv();
    const status = await client.getStatus(jobId);
    const state = jobState(status);
    if (!isTerminalState(state)) {
      throw new ProviderError(
        `Sume job ${jobId} is ${state}, not finished. Wait for it with: multix sume status ${jobId} --wait --download`,
        SUME_PROVIDER,
      );
    }
    await deliverJob(jobId, status, { client, logger, opts, download: opts.download !== false });
  });

  parent
    .command("cancel <jobId>")
    .description("Cancel a Sume job before it starts generating (its reservation is refunded)")
    .action(async (jobId: string) => {
      const client = createSumeClientFromEnv();
      const result = await client.cancel(jobId);
      console.log(JSON.stringify(result, null, 2));
    });
}
