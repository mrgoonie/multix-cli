import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getVideoPrediction } from "../client.js";
import { positiveInteger, saveCompletedVideo, waitForVideo } from "./video-helpers.js";

export function registerCloudflareVideoStatusCommand(parent: Command): void {
  parent
    .command("video-status <id>")
    .description("Check, wait for, or download a Cloudflare AI Gateway video prediction")
    .option("--wait", "Poll until the prediction succeeds or fails")
    .option("--wait-timeout <ms>", "Polling timeout in ms", "600000")
    .option("--download", "Download the completed video (implies --wait)")
    .option("--output <path>", "Save video at this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        id: string,
        opts: {
          wait?: boolean;
          waitTimeout: string;
          download?: boolean;
          output?: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const shouldWait = Boolean(opts.wait || opts.download);
        const prediction = await getVideoPrediction(id);
        const completed =
          shouldWait && prediction.status !== "succeeded"
            ? await waitForVideo(
                prediction,
                positiveInteger(opts.waitTimeout, "--wait-timeout"),
                (status) => logger.debug(`Video status: ${status}`),
              )
            : prediction;

        console.log(`${completed.id}: ${completed.status}`);
        if (opts.download) {
          if (completed.status !== "succeeded") {
            logger.warn(`Cannot download while status is ${completed.status}`);
            return;
          }
          const destination = await saveCompletedVideo(completed, opts.output);
          logger.success(`Saved ${destination}`);
          console.log(destination);
        }
      },
    );
}
