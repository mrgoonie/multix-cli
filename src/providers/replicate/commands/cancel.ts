/**
 * multix replicate cancel <id> — cancel a running prediction
 * (POST /v1/predictions/{id}/cancel).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { isTerminalStatus } from "../models.js";
import { createReplicateClient } from "../node-client.js";

export function registerReplicateCancelCommand(parent: Command): void {
  parent
    .command("cancel <predictionId>")
    .description("Cancel a running Replicate prediction")
    .option("-v, --verbose", "Verbose logging")
    .action(async (predictionId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createReplicateClient();
      const prediction = await client.cancelPrediction(predictionId);
      if (prediction.status === "canceled") {
        logger.success(`Prediction ${prediction.id} canceled`);
      } else if (isTerminalStatus(prediction.status)) {
        logger.warn(`Prediction ${prediction.id} already finished (status: ${prediction.status})`);
      } else {
        logger.info(`Cancel requested for ${prediction.id} (status: ${prediction.status})`);
      }
    });
}
