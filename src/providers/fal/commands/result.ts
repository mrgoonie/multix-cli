/**
 * multix fal result [model] <requestId> — fetch a completed job's result.
 * `--download` saves any media URLs found in the payload to MULTIX_OUTPUT_DIR
 * (or `--output-dir`). Never submits anything: safe to repeat after a timeout.
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient, resultPath } from "../client.js";
import { updateReceiptStatus } from "../job-receipts.js";
import { downloadResultMedia, extractMediaUrls } from "../run-helpers.js";
import type { FalResultResponse } from "../types.js";
import { resolveJobRef } from "./job-ref.js";

export function registerFalResultCommand(parent: Command): void {
  parent
    .command("result <modelOrRequestId> [requestId]")
    .description(
      "Fetch a completed fal.ai request's result (model optional when a receipt was saved)",
    )
    .option("--download", "Download media URLs found in the result to the output dir")
    .option("--output-dir <dir>", "Directory for --download (default: MULTIX_OUTPUT_DIR)")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        first: string,
        second: string | undefined,
        opts: { download?: boolean; outputDir?: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const { model, requestId } = resolveJobRef(first, second);
        const client = createFalClient();

        let result: FalResultResponse;
        try {
          result = await client.get<FalResultResponse>(resultPath(model, requestId), logger);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Failed to fetch result for fal request ${requestId}: ${msg}`);
          logger.info(`If it is still running, check: multix fal status ${model} ${requestId}`);
          process.exit(1);
        }
        updateReceiptStatus(requestId, "COMPLETED");

        if (!opts.download) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const urls = extractMediaUrls(result);
        if (urls.length === 0) {
          logger.warn("No media URLs found in result.");
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
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
