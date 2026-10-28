/**
 * multix sume cancel <jobId> — cancel a job that has not started generating.
 * Sume refunds a canceled job. Once generation has started Sume refuses
 * (409 job_generation_already_started): the job finishes and is charged.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { assertJobId } from "../models.js";
import { createSumeClient } from "../node-client.js";

export function registerSumeCancelCommand(parent: Command): void {
  parent
    .command("cancel <jobId>")
    .description("Cancel a Sume job before generation starts (refunded)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (jobId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertJobId(jobId);
      const result = await createSumeClient().cancel(id);
      console.log(JSON.stringify(result, null, 2));
      if (result.idempotencyHit) logger.info(`Sume job ${id} was already canceled`);
      else if (result.canceled)
        logger.success(`Canceled Sume job ${id}; Sume refunds canceled jobs`);
      else
        logger.warn(`Sume did not cancel job ${id}${result.message ? `: ${result.message}` : ""}`);
    });
}
