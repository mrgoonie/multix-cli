/**
 * multix sume status <jobId> — inspect or resume a job without submitting a
 * new one. Prints a JSON summary; --wait polls to a terminal status;
 * --download saves the artifacts of a completed job. stdout carries only the
 * result, so `multix sume status <id> | jq` parses whether or not the job has
 * finished. Failed and canceled jobs exit non-zero.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { SumeJobFailedError } from "../errors.js";
import { assertJobId } from "../models.js";
import { createSumeClient } from "../node-client.js";
import {
  completeJob,
  failJob,
  logSettlement,
  parsePositiveInt,
  reportArtifacts,
  resumeCommand,
  summarizeJob,
} from "./job-flow.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerSumeStatusCommand(parent: Command): void {
  parent
    .command("status <jobId>")
    .description("Get a Sume job's status; --wait/--download to resume it")
    .option("--wait", "Poll until the job reaches a terminal status")
    .option("--download", "Download artifacts once completed")
    .option("--output <path>", "Output file path, or a directory for multiple artifacts")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "1800000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (jobId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertJobId(jobId);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const client = createSumeClient();

      if (opts.wait) {
        try {
          await completeJob(client, id, {
            waitTimeoutMs,
            logger,
            download: Boolean(opts.download),
            output: opts.output,
          });
        } catch (error) {
          // A failed or canceled job still gets its JSON summary (reason, refund).
          if (!opts.download && error instanceof SumeJobFailedError) {
            console.log(JSON.stringify(summarizeJob(error.job), null, 2));
          }
          throw error;
        }
        return;
      }

      const job = await client.getStatus(id);
      if (job.status === "completed") {
        logSettlement(logger, job);
        const result = await client.getResult(id);
        await reportArtifacts(id, result.artifacts, {
          download: Boolean(opts.download),
          output: opts.output,
          logger,
        });
        return;
      }
      if (!job.terminal) {
        console.log(JSON.stringify(summarizeJob(job), null, 2));
        logger.info(`Still ${job.status}. Resume with: ${resumeCommand(job.id)}`);
        return;
      }
      try {
        await failJob(client, job, logger);
      } catch (error) {
        if (error instanceof SumeJobFailedError) {
          console.log(JSON.stringify(summarizeJob(error.job), null, 2));
        }
        throw error;
      }
    });
}
