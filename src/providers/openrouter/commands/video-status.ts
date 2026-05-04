/**
 * multix openrouter video-status <jobId> — poll an OpenRouter video job.
 *
 * Default: single GET (backward-compatible).
 * --wait: polls until status is `completed` / `failed`.
 * --download: streams the video to MULTIX_OUTPUT_DIR (or --output <path>).
 *   Auto-detects a thumbnail URL in the response and saves it as `<base>_thumb.<ext>`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { PollFailedError, PollTimeoutError, poll } from "../../leonardo/poll.js";
import { requireOpenRouterKey } from "../client.js";
import {
  type OpenRouterVideoPollResponse,
  pollVideoJob,
  videoContentUrl,
} from "../video-client.js";

export interface OpenRouterDownloadOpts {
  jobId: string;
  output?: string;
  thumb?: boolean;
  logger: ReturnType<typeof createLogger>;
  source: OpenRouterVideoPollResponse;
}

export async function downloadOpenRouterVideo(opts: OpenRouterDownloadOpts): Promise<string> {
  const { jobId, logger, source } = opts;
  const apiKey = requireOpenRouterKey();
  const url = videoContentUrl(jobId);
  const dest = path.join(getOutputDir(), `openrouter_video_${jobId}.mp4`);
  const r = await globalThis.fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) {
    logger.error(`Download HTTP ${r.status}`);
    process.exit(1);
  }
  if (!r.body) {
    logger.error("Empty response body");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ws = fs.createWriteStream(dest);
  const { pipeline } = await import("node:stream/promises");
  await pipeline(r.body as unknown as NodeJS.ReadableStream, ws);
  logger.success(`Saved ${dest}`);
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(dest, opts.output);
    logger.success(`Copied to ${opts.output}`);
  }
  await maybeDownloadThumb(source, dest, {
    skip: opts.thumb === false,
    copyTo: opts.output,
    logger,
  });
  return dest;
}

export function registerOpenRouterVideoStatusCommand(parent: Command): void {
  parent
    .command("video-status <jobId>")
    .description("Poll an OpenRouter video generation job")
    .option("--wait", "Poll until status is 'completed' or 'failed'")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "If completed, download the video (implies --wait)")
    .option("--output <path>", "Copy downloaded video to this path")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        jobId: string,
        opts: {
          wait?: boolean;
          waitTimeout: string;
          download?: boolean;
          output?: string;
          thumb?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const shouldWait = !!(opts.wait || opts.download);

        let res: OpenRouterVideoPollResponse;
        try {
          res = shouldWait
            ? await poll<OpenRouterVideoPollResponse>({
                fetch: () => pollVideoJob(jobId),
                done: (v) => v.status === "completed",
                failed: (v) => v.status === "failed",
                intervalMs: 5000,
                maxAttempts: Math.max(
                  1,
                  Math.ceil((Number.parseInt(opts.waitTimeout, 10) || 600_000) / 5000),
                ),
                onTick: (n, v) => logger.debug(`attempt ${n} — status: ${v.status}`),
              })
            : await pollVideoJob(jobId);
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(`Timed out waiting for job ${jobId}`);
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Job failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }

        console.error(`status: ${res.status}`);
        for (const u of res.unsigned_urls ?? []) console.log(u);

        if (opts.download && res.status === "completed") {
          await downloadOpenRouterVideo({
            jobId,
            output: opts.output,
            thumb: opts.thumb,
            logger,
            source: res,
          });
        } else if (opts.download) {
          logger.warn(`Cannot download — status is '${res.status}', not 'completed'`);
        }

        if (res.usage?.cost !== undefined) {
          logger.debug(`cost: ${res.usage.cost}${res.usage.is_byok ? " (BYOK)" : ""}`);
        }
      },
    );
}
