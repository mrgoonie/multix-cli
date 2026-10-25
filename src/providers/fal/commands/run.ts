/**
 * multix fal run <model> — generic runner for any fal.ai model.
 * Uploads `--file` inputs, submits, saves a receipt (so a killed or timed-out
 * run can be resumed with `fal status`/`fal result`), polls to completion,
 * then prints or downloads any media URLs found in the result payload.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { buildReceipt, saveReceipt, updateReceiptStatus } from "../job-receipts.js";
import { downloadResultMedia, extractMediaUrls, submitAndWait } from "../run-helpers.js";
import { type JobInputOptions, addJobInputOptions, prepareJobInput } from "./job-input.js";

export function registerFalRunCommand(parent: Command): void {
  const cmd = parent
    .command("run <model>")
    .description("Run any fal.ai model by id (e.g. fal-ai/flux/schnell)");
  addJobInputOptions(cmd)
    .option("--no-download", "Skip downloading media; print result JSON only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        model: string,
        opts: JobInputOptions & { download: boolean; waitTimeout: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const { input, uploadedFields } = await prepareJobInput(opts, logger);

        logger.info(`Submitting to ${model}...`);
        const { requestId, result } = await submitAndWait({
          model,
          input,
          logger,
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 480_000,
          onSubmitted: (submitted) => {
            try {
              saveReceipt(buildReceipt(model, input, submitted, uploadedFields));
            } catch (e) {
              logger.warn(`Could not save the job receipt: ${e instanceof Error ? e.message : e}`);
            }
          },
        });
        updateReceiptStatus(requestId, "COMPLETED");

        if (opts.download === false) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const urls = extractMediaUrls(result);
        if (urls.length === 0) {
          logger.warn("No media URLs found in result; printing raw JSON.");
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const outDir = getOutputDir();
        const saved = await downloadResultMedia(urls, outDir, requestId, logger);
        if (saved.length === 0) {
          logger.error(`Found ${urls.length} media URL(s) but none downloaded successfully.`);
          process.exit(1);
        }
        console.log(`\nDownloaded ${saved.length} file(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
