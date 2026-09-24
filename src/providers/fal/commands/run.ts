/**
 * multix fal run <model> — generic runner for any fal.ai model.
 * Submits, polls to completion, then prints or downloads any media URLs found
 * in the result payload.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import {
  downloadResultMedia,
  extractMediaUrls,
  parseInputArg,
  submitAndWait,
} from "../run-helpers.js";

export function registerFalRunCommand(parent: Command): void {
  parent
    .command("run <model>")
    .description("Run any fal.ai model by id (e.g. fal-ai/flux/schnell)")
    .requiredOption("--input <json>", "JSON input, or @path/to/file.json")
    .option("--no-download", "Skip downloading media; print result JSON only")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        model: string,
        opts: { input: string; download: boolean; waitTimeout: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const input = parseInputArg(opts.input);

        logger.info(`Submitting to ${model}...`);
        const { requestId, result } = await submitAndWait({
          model,
          input,
          logger,
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 480_000,
        });

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
        console.log(`\nDownloaded ${saved.length} file(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
