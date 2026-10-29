/**
 * multix sume status <job-id> — inspect or resume a job without creating a
 * new one. Prints a JSON summary; --wait polls to a terminal status;
 * --download saves the artifacts; --no-download prints their URLs.
 * stdout carries only the result (the JSON, URLs or saved file list):
 * progress and resume hints go to stderr.
 * Failed and canceled jobs exit non-zero with Sume's reason (both are refunded).
 * A completed job's captured charge is read so the run records what Sume billed.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { SumeJobError } from "../client.js";
import { assertJobId } from "../models.js";
import { createSumeClient } from "../node-client.js";
import {
  type OutputFlagOptions,
  completeJob,
  parsePositiveInt,
  readCapturedCharge,
  reportOutputs,
  resumeCommand,
  summarizeStatus,
} from "./job-flow.js";

interface StatusOpts extends OutputFlagOptions {
  wait?: boolean;
}

export function registerSumeStatusCommand(parent: Command): void {
  parent
    .command("status <jobId>")
    .description("Get a Sume job's status; --wait/--download to resume it")
    .option("--wait", "Poll until the job reaches a terminal status")
    .option("--download", "Download the artifacts once completed")
    .option("--no-download", "Print the artifact URLs instead of a summary")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (jobId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertJobId(jobId);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const client = createSumeClient();
      const report = { download: opts.download, output: opts.output, logger };

      if (opts.wait) {
        await completeJob(client, id, { waitTimeoutMs, ...report });
        return;
      }
      const status = await client.getStatus(id);
      if (status.status === "completed") await readCapturedCharge(client, id, logger);
      if (status.status === "completed" && opts.download !== undefined) {
        await reportOutputs(client, id, report);
        return;
      }
      if (status.terminal && status.status !== "completed") {
        const job = await client.getJob(id).catch(() => undefined);
        console.log(JSON.stringify(summarizeStatus(status, job), null, 2));
        throw new SumeJobError(id, status.status, job?.error);
      }
      console.log(JSON.stringify(summarizeStatus(status), null, 2));
      if (!status.terminal) logger.info(`Still running. Resume with: ${resumeCommand(id)}`);
      else logger.info(`Download with: multix sume status ${id} --download`);
    });
}
