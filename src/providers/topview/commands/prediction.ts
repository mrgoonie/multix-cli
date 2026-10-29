/**
 * `topview prediction <id>` (API Platform): inspect or resume a prediction
 * without creating a new one. Prints a JSON summary (URLs without query
 * strings) with charged_usd and billing_state; --wait polls until completed,
 * failed or payment_required; --download saves the outputs. stdout carries
 * only the result. failed and payment_required exit non-zero.
 */

import type { Command } from "commander";
import { nameJob } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { TopviewPredictionError } from "../errors.js";
import { assertPredictionId, isPlatformTerminalStatus } from "../models.js";
import { createTopviewPlatformClient } from "../node-client.js";
import {
  completePrediction,
  logPlatformCost,
  parsePositiveInt,
  predictionResumeCommand,
  reportPredictionOutputs,
  summarizePrediction,
} from "./task-flow.js";

interface PredictionOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerTopviewPredictionCommand(parent: Command): void {
  parent
    .command("prediction <id>")
    .description("API Platform: get a prediction's status; --wait/--download to resume it")
    .option("--wait", "Poll until completed, failed or payment_required")
    .option("--download", "Download outputs once completed")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "1800000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (idRaw: string, opts: PredictionOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertPredictionId(idRaw);
      // Name the job read here, so a failed read still joins its operation.
      nameJob(id);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      if (opts.output !== undefined && !opts.download) {
        throw new ValidationError("--output needs --download");
      }
      const client = createTopviewPlatformClient();

      if (opts.wait) {
        try {
          await completePrediction(client, id, {
            waitTimeoutMs,
            logger,
            download: Boolean(opts.download),
            output: opts.output,
          });
        } catch (error) {
          if (!opts.download && error instanceof TopviewPredictionError) {
            console.log(JSON.stringify(summarizePrediction(error.prediction), null, 2));
          }
          throw error;
        }
        return;
      }

      const p = await client.getPrediction(id);
      logPlatformCost(logger, p);
      if (p.status === "completed" && opts.download) {
        await reportPredictionOutputs(p, { download: true, output: opts.output, logger });
        return;
      }
      console.log(JSON.stringify(summarizePrediction(p), null, 2));
      if (!isPlatformTerminalStatus(p.status)) {
        logger.info(`Still running. Resume with: ${predictionResumeCommand(p.id)}`);
      } else if (p.status !== "completed") {
        throw new TopviewPredictionError(p);
      }
    });
}
