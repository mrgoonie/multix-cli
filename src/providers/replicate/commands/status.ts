/**
 * multix replicate status <id> — inspect or resume a prediction by id without
 * re-running inference. `--wait` polls to a terminal status; `--download`
 * saves media outputs. failed/canceled/aborted predictions exit non-zero.
 */

import type { Command } from "commander";
import { nameJob } from "../../../agent/run-state.js";
import { createLogger } from "../../../core/logger.js";
import { ReplicatePredictionError } from "../client.js";
import { isTerminalStatus } from "../models.js";
import { createReplicateClient } from "../node-client.js";
import { summarizePrediction } from "../output.js";
import {
  completePrediction,
  parsePositiveInt,
  reportOutputs,
  resumeCommand,
} from "./prediction-flow.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerReplicateStatusCommand(parent: Command): void {
  parent
    .command("status <predictionId>")
    .description("Get a Replicate prediction's status; --wait/--download to resume it")
    .option("--wait", "Poll until the prediction reaches a terminal status")
    .option("--download", "Download media outputs once succeeded")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (predictionId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createReplicateClient();
      // Name the job read here, so a failed read still joins its operation.
      nameJob(predictionId);

      if (opts.wait) {
        await completePrediction(client, predictionId, {
          waitTimeoutMs: parsePositiveInt(opts.waitTimeout, "--wait-timeout"),
          logger,
          download: Boolean(opts.download),
          output: opts.output,
        });
        return;
      }

      const prediction = await client.getPrediction(predictionId);
      if (prediction.status === "succeeded" && opts.download) {
        await reportOutputs(prediction, { download: true, output: opts.output, logger });
        return;
      }
      console.log(JSON.stringify(summarizePrediction(prediction), null, 2));
      if (!isTerminalStatus(prediction.status)) {
        logger.info(`Still running. Resume with: ${resumeCommand(prediction.id)}`);
      } else if (prediction.status !== "succeeded") {
        throw new ReplicatePredictionError(prediction);
      }
    });
}
