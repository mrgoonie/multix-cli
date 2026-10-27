/**
 * multix atlas status <predictionId> — resume an async prediction.
 * One GET by default; --wait polls (bounded) until terminal; --download
 * (implies --wait) saves the outputs. A failed prediction exits non-zero.
 * Atlas documents no cancel endpoint, so none is offered.
 */

import type { Command } from "commander";
import { trackInFlight } from "../../../agent/run-state.js";
import { imageFormatOption, noWebpOption } from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import { AtlasPredictionFailedError, assertPredictionSucceeded } from "../client.js";
import { isFailureStatus } from "../prediction-output.js";
import type { AtlasPrediction } from "../types.js";
import { createAtlasClientFromEnv } from "./env.js";
import {
  type RunCliOpts,
  cancelledWithResume,
  deliverPrediction,
  exitOnInterrupt,
  parseTimeoutMs,
  resumeCommand,
} from "./prediction-runner.js";

const STATUS_WAIT_MS = 600_000;

/** Print the prediction; a failed one exits non-zero. */
function report(prediction: AtlasPrediction): void {
  console.log(JSON.stringify(prediction, null, 2));
  if (isFailureStatus(prediction.status)) throw new AtlasPredictionFailedError(prediction);
}

interface StatusFlags extends RunCliOpts {
  wait?: boolean;
}

export function registerAtlasStatusCommand(parent: Command): void {
  parent
    .command("status <predictionId>")
    .description("Get an Atlas Cloud prediction; --wait to poll, --download to save outputs")
    .option("--wait", "Poll until the prediction finishes")
    .option("--wait-timeout <ms>", "Max time to wait (with --wait)", String(STATUS_WAIT_MS))
    .option("--download", "Save outputs when finished (implies --wait)")
    .option("--output <path>", "Output file (single output) or directory (path without extension)")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("--no-thumb", "Skip downloading the video thumbnail if present")
    .option("-v, --verbose", "Verbose logging")
    .action(async (predictionId: string, opts: StatusFlags) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createAtlasClientFromEnv();
      const wait = Boolean(opts.wait || opts.download);
      if (!wait) {
        report(await client.getPrediction(predictionId));
        return;
      }
      const resume = resumeCommand(predictionId, opts.output);
      // The id is known: a signal while waiting or saving reports how to resume, not a rerun.
      trackInFlight(predictionId, resume);
      await exitOnInterrupt(
        async () => {
          const prediction = await client.waitForPrediction(predictionId, {
            timeoutMs: parseTimeoutMs(opts.waitTimeout, STATUS_WAIT_MS),
            resumeHint: `Resume with: ${resume}`,
            onPoll: (p, n) => logger.debug(`poll ${n}: ${p.status}`),
          });
          if (!opts.download) {
            report(prediction);
            return;
          }
          assertPredictionSucceeded(prediction);
          await deliverPrediction(prediction, {
            logger,
            opts: { ...opts, download: true },
            predictionId,
          });
        },
        () => cancelledWithResume(predictionId, resume),
      );
    });
}
