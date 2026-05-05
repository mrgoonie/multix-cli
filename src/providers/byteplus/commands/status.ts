/**
 * multix byteplus status <taskId> — query a Seedance video task.
 * Single GET by default; --wait polls until terminal; --download fetches the MP4.
 * Note: ARK does not expose a verified cancel/delete endpoint — no --cancel.
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { PollFailedError, PollTimeoutError } from "../../leonardo/poll.js";
import { createBytePlusClient } from "../client.js";
import { downloadModelFile, inferModelFileExt } from "../generators/three-d.js";
import { downloadVideo, getVideoTaskStatus, waitForVideoTask } from "../generators/video.js";

export function registerBytePlusStatusCommand(parent: Command): void {
  parent
    .command("status <taskId>")
    .description("Get a Seedance task's status; --wait + --download to fetch the result MP4")
    .option("--wait", "Poll until terminal status")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "Download MP4 on success (implies --wait)")
    .option("--output <path>", "Output MP4 path (with --download)")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        taskId: string,
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
        const client = createBytePlusClient();
        const shouldWait = !!(opts.wait || opts.download);

        try {
          const status = shouldWait
            ? await waitForVideoTask(client, taskId, {
                waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 600_000,
                logger,
              })
            : await getVideoTaskStatus(client, taskId, logger);

          console.log(JSON.stringify(status, null, 2));

          if (opts.download && status.status === "succeeded") {
            const content = status.content as { video_url?: string; file_url?: string } | undefined;
            const videoUrl = content?.video_url;
            const fileUrl = content?.file_url;
            if (videoUrl) {
              const outPath =
                opts.output ??
                path.join(getOutputDir(), `byteplus-video-${taskId.slice(0, 8)}.mp4`);
              await downloadVideo(videoUrl, outPath, logger);
              await maybeDownloadThumb(status, outPath, {
                skip: opts.thumb === false,
                copyTo: opts.output,
                logger,
              });
              console.log(`Saved: ${outPath}`);
            } else if (fileUrl) {
              const ext = inferModelFileExt(fileUrl);
              const outPath =
                opts.output ??
                path.join(getOutputDir(), `byteplus-3d-${taskId.slice(0, 8)}.${ext}`);
              await downloadModelFile(fileUrl, outPath, logger);
              console.log(`Saved: ${outPath}`);
            } else {
              logger.error("Task succeeded but no video_url or file_url present");
              process.exit(1);
            }
          }
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(`Timed out waiting for task ${taskId}`);
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Task failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }
      },
    );
}
