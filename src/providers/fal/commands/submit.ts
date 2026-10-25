/**
 * multix fal submit <model> — queue a job on any fal model and return as soon
 * as fal accepts it. The receipt (model, request_id, input hash, queue URLs)
 * is saved to ~/.multix/fal-jobs/ before it is printed, so `fal status` and
 * `fal result` can pick the job up later without submitting it again.
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createFalClient } from "../client.js";
import { buildReceipt, saveReceipt, writeJsonAtomic } from "../job-receipts.js";
import { submitJob } from "../run-helpers.js";
import { type JobInputOptions, addJobInputOptions, prepareJobInput } from "./job-input.js";

export function registerFalSubmitCommand(parent: Command): void {
  const cmd = parent
    .command("submit <model>")
    .description("Queue a job on any fal.ai model without waiting; prints a JSON receipt");
  addJobInputOptions(cmd)
    .option("--receipt <path>", "Also write the receipt JSON to this file")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (model: string, opts: JobInputOptions & { receipt?: string; verbose?: boolean }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
        const { input, uploadedFields } = await prepareJobInput(opts, logger);

        logger.info(`Submitting to ${model}...`);
        const client = createFalClient();
        const submitted = await submitJob(client, model, input, logger);
        const receipt = buildReceipt(model, input, submitted, uploadedFields);
        // Persist before printing, so a killed process still leaves the id on disk.
        let receiptPath: string | undefined;
        try {
          receiptPath = saveReceipt(receipt);
        } catch (e) {
          logger.warn(
            `Could not save the receipt (${e instanceof Error ? e.message : e}); keep the request_id printed below.`,
          );
        }
        if (opts.receipt) {
          try {
            writeJsonAtomic(path.resolve(opts.receipt), receipt);
          } catch (e) {
            logger.warn(`Could not write --receipt: ${e instanceof Error ? e.message : e}`);
          }
        }

        console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2));
        logger.info(`Check: multix fal status ${model} ${receipt.request_id}`);
        logger.info(`Collect: multix fal result ${model} ${receipt.request_id} --download`);
      },
    );
}
