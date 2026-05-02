/**
 * multix openrouter video-status <jobId> — poll an OpenRouter video job.
 *
 * If --download is given and status is `completed`, streams the video to
 * MULTIX_OUTPUT_DIR (or --output <path>).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { requireOpenRouterKey } from "../client.js";
import { pollVideoJob, videoContentUrl } from "../video-client.js";

export function registerOpenRouterVideoStatusCommand(parent: Command): void {
  parent
    .command("video-status <jobId>")
    .description("Poll an OpenRouter video generation job (one-shot)")
    .option("--download", "If completed, download the video to MULTIX_OUTPUT_DIR")
    .option("--output <path>", "Copy downloaded video to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (jobId: string, opts: { download?: boolean; output?: string; verbose?: boolean }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const res = await pollVideoJob(jobId);
        console.error(`status: ${res.status}`);
        for (const u of res.unsigned_urls ?? []) console.log(u);

        if (opts.download && res.status === "completed") {
          // Use the authenticated /content endpoint when no signed URLs are present.
          const apiKey = requireOpenRouterKey();
          const url = videoContentUrl(jobId);
          const dest = path.join(getOutputDir(), `openrouter_video_${jobId}.mp4`);
          // downloadFile in core uses fetch directly; for auth we need a manual fetch.
          const r = await globalThis.fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
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
        } else if (opts.download) {
          logger.warn(`Cannot download — status is '${res.status}', not 'completed'`);
        }

        if (res.usage?.cost !== undefined) {
          logger.debug(`cost: ${res.usage.cost}${res.usage.is_byok ? " (BYOK)" : ""}`);
        }
      },
    );
}
