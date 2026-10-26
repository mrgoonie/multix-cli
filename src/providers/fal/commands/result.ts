/**
 * multix fal result <model> <requestId> — fetch a completed job's result.
 * `--download` saves any media URLs found in the payload to MULTIX_OUTPUT_DIR
 * (or `--output-dir`). Only reads: it never submits the job again.
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient, resultPath } from "../client.js";
import { downloadResultMedia, extractMediaRefs } from "../run-helpers.js";
import type { FalResultResponse } from "../types.js";

export function registerFalResultCommand(parent: Command): void {
  parent
    .command("result <model> <requestId>")
    .description("Fetch a completed fal.ai request's result")
    .option("--download", "Download media URLs found in the result to the output dir")
    .option(
      "--output-dir <dir>",
      "Download media here (default MULTIX_OUTPUT_DIR or ./multix-output)",
    )
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        model: string,
        requestId: string,
        opts: { download?: boolean; outputDir?: string; verbose?: boolean },
      ) => {
        // Progress goes to stderr so stdout stays the result JSON or the saved paths.
        const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
        const client = createFalClient();

        let result: FalResultResponse;
        try {
          result = await client.get<FalResultResponse>(resultPath(model, requestId), logger);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Failed to fetch result for fal request ${requestId}: ${msg}`);
          process.exit(1);
        }

        if (!opts.download) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const refs = extractMediaRefs(result);
        if (refs.length === 0) {
          logger.warn("No media URLs found in result.");
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
        const saved = await downloadResultMedia(refs, outDir, requestId, logger);
        if (saved.length === 0) {
          logger.error(`Found ${refs.length} media URL(s) but none downloaded successfully.`);
          process.exit(1);
        }
        console.log(`\nDownloaded ${saved.length} file(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}
