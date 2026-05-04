/**
 * multix leonardo status <generationId> — fetch a generation's status and asset URLs.
 *
 * Default: single GET; prints status and any image/video URLs.
 * --wait: poll until COMPLETE/FAILED.
 * --download: download all asset URLs to MULTIX_OUTPUT_DIR (implies --wait).
 *   Auto-detects thumbnails next to each asset and saves them as `<base>_thumb.<ext>`.
 */

import path from "node:path";
import type { Command } from "commander";
import { downloadFile } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { createLeonardoClient } from "../client.js";
import { PollFailedError, PollTimeoutError, poll } from "../poll.js";
import type { Generation, GetGenerationResponse } from "../types.js";

const VIDEO_KEYS = ["motionMP4URL", "url"];
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)(\?|$)/i;

function collectAssetUrls(gen: Generation): { videos: string[]; images: string[] } {
  const videos: string[] = [];
  const images: string[] = [];
  for (const img of gen.generated_images ?? []) {
    if (!img.url) continue;
    if (VIDEO_EXT_RE.test(img.url)) videos.push(img.url);
    else if (IMAGE_EXT_RE.test(img.url)) images.push(img.url);
    else images.push(img.url);
    for (const k of VIDEO_KEYS) {
      const extra = (img as unknown as Record<string, unknown>)[k];
      if (typeof extra === "string" && VIDEO_EXT_RE.test(extra)) videos.push(extra);
    }
  }
  return { videos, images };
}

export function registerLeonardoStatusCommand(parent: Command): void {
  parent
    .command("status <generationId>")
    .description("Get a Leonardo generation's status and asset URLs")
    .option("--wait", "Poll until COMPLETE or FAILED")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "Download assets on success (implies --wait)")
    .option("--output <path>", "Output directory or single-file path (with --download)")
    .option("--no-thumb", "Skip downloading thumbnails if the API returns them")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        generationId: string,
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
        const client = createLeonardoClient();
        const shouldWait = !!(opts.wait || opts.download);

        const fetchOnce = () =>
          client.get<GetGenerationResponse>(`/generations/${generationId}`, undefined, logger);

        let res: GetGenerationResponse;
        try {
          res = shouldWait
            ? await poll<GetGenerationResponse>({
                fetch: fetchOnce,
                done: (v) => v.generations_by_pk?.status === "COMPLETE",
                failed: (v) => v.generations_by_pk?.status === "FAILED",
                intervalMs: 5000,
                maxAttempts: Math.max(
                  1,
                  Math.ceil((Number.parseInt(opts.waitTimeout, 10) || 600_000) / 5000),
                ),
                onTick: (n, v) =>
                  logger.debug(`attempt ${n} — status: ${v.generations_by_pk?.status}`),
              })
            : await fetchOnce();
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(`Timed out waiting for generation ${generationId}`);
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Generation failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }

        const gen = res.generations_by_pk;
        if (!gen) {
          logger.warn("No generation found.");
          return;
        }
        console.error(`status: ${gen.status}`);

        const { videos, images } = collectAssetUrls(gen);
        for (const u of [...videos, ...images]) console.log(u);

        if (!opts.download || gen.status !== "COMPLETE") {
          if (opts.download) logger.warn(`Cannot download — status is '${gen.status}'`);
          return;
        }

        const outDir = getOutputDir();
        let idx = 0;
        for (const url of videos) {
          const dest =
            opts.output && videos.length === 1 && images.length === 0
              ? opts.output
              : path.join(outDir, `leonardo-${generationId.slice(0, 8)}-${idx}.mp4`);
          await downloadFile(url, dest);
          logger.success(`Saved ${dest}`);
          await maybeDownloadThumb(gen, dest, {
            skip: opts.thumb === false,
            copyTo: opts.output,
            logger,
          });
          idx++;
        }
        for (const url of images) {
          const m = url.match(IMAGE_EXT_RE);
          const ext = m?.[1] ? m[1].toLowerCase().replace("jpeg", "jpg") : "png";
          const dest = path.join(outDir, `leonardo-${generationId.slice(0, 8)}-${idx}.${ext}`);
          await downloadFile(url, dest);
          logger.success(`Saved ${dest}`);
          idx++;
        }
      },
    );
}
