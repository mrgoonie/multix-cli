/**
 * multix fal result <model> <requestId> — fetch a completed job's result.
 * `--download` saves any media URLs found in the payload to MULTIX_OUTPUT_DIR
 * (or `--output-dir`). Only reads: it never submits the job again. A job that
 * is still queued or running fails with JOB_PENDING and its queue status.
 */

import type { Command } from "commander";
import { MultixError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { type FalClient, HttpError, createFalClient, resultPath, statusPath } from "../client.js";
import { downloadResultMedia, extractMediaUrls } from "../run-helpers.js";
import type { FalResultResponse, FalStatusResponse } from "../types.js";
import { resolveDownloadDir } from "./run.js";

/** Queue status when it says the job is not finished; undefined otherwise. */
async function pendingStatus(
  client: FalClient,
  model: string,
  requestId: string,
): Promise<FalStatusResponse | undefined> {
  try {
    const res = await client.get<FalStatusResponse>(statusPath(model, requestId));
    return res.status === "IN_QUEUE" || res.status === "IN_PROGRESS" ? res : undefined;
  } catch {
    return undefined;
  }
}

export function registerFalResultCommand(parent: Command): void {
  parent
    .command("result <model> <requestId>")
    .description("Fetch a completed fal.ai request's result")
    .option("--download", "Download media URLs found in the result to the output dir")
    .option("--output-dir <dir>", "Directory for downloaded media (default: MULTIX_OUTPUT_DIR)")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        model: string,
        requestId: string,
        opts: { download?: boolean; outputDir?: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createFalClient();

        let result: FalResultResponse;
        try {
          result = await client.get<FalResultResponse>(resultPath(model, requestId), logger);
        } catch (e) {
          // fal answers 4xx for a result that is not ready; ask the queue why.
          const pending =
            e instanceof HttpError && e.status >= 400 && e.status < 500
              ? await pendingStatus(client, model, requestId)
              : undefined;
          if (pending) {
            const position =
              pending.queue_position !== undefined
                ? ` (queue position ${pending.queue_position})`
                : "";
            throw new MultixError(
              `fal request ${requestId} is ${pending.status}${position}; no result yet. Check again with: multix fal status ${model} ${requestId}`,
              "JOB_PENDING",
            );
          }
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Failed to fetch result for fal request ${requestId}: ${msg}`);
          process.exit(1);
        }

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

        const outDir = resolveDownloadDir(opts.outputDir);
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
