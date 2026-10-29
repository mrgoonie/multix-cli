/**
 * multix sume cancel <job-id> — cancel a job that has not started generating
 * (Sume refunds it). Sume refuses once generation started (the job runs and
 * is billed) or after the job ended; both exit non-zero with that reason.
 * Canceling an already canceled job succeeds.
 */

import type { Command } from "commander";
import { ProviderError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { SumeApiError } from "../client.js";
import { assertJobId } from "../models.js";
import { createSumeClient } from "../node-client.js";

export function registerSumeCancelCommand(parent: Command): void {
  parent
    .command("cancel <jobId>")
    .description("Cancel a Sume job before generation starts (refunded)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (jobId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const id = assertJobId(jobId);
      const client = createSumeClient();
      try {
        const result = await client.cancel(id);
        if (result.alreadyCanceled) logger.info(`Job ${id} was already canceled`);
        else logger.success(`Job ${id} canceled; Sume refunds its reserved charge`);
      } catch (error) {
        if (error instanceof SumeApiError && error.status === 409) {
          if (error.sumeCode === "job_generation_already_started") {
            throw new ProviderError(
              `Job ${id} cannot be canceled: generation already started, so it runs to the end and is billed when it completes (multix sume status ${id})`,
              "sume",
              { cause: error },
            );
          }
          if (error.sumeCode === "job_not_cancelable") {
            throw new ProviderError(
              `Job ${id} cannot be canceled: it already finished (multix sume status ${id})`,
              "sume",
              { cause: error },
            );
          }
        }
        throw error;
      }
    });
}
