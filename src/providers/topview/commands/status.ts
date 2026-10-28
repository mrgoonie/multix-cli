/**
 * multix topview status <kind> <taskId> — inspect or resume a task without
 * creating a new one. Prints a JSON summary (output URLs without their signed
 * query strings); --wait polls to a terminal status; --download saves the
 * outputs. stdout carries only the result; hints go to stderr. Failed tasks
 * exit non-zero.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { TopviewTaskError } from "../client.js";
import {
  STATUS_KINDS,
  assertLegacyId,
  assertPredictionId,
  isLegacyTerminal,
  parseStatusKind,
} from "../models.js";
import { createTopviewClient, createTopviewPlatformClient } from "../node-client.js";
import {
  TopviewPaymentRequiredError,
  TopviewPredictionError,
  assertPredictionCompleted,
  isPredictionStopped,
} from "../platform-client.js";
import {
  completeLegacyTask,
  completePrediction,
  logCharge,
  parsePositiveInt,
  reportOutputs,
  resumeCommand,
  summarizeLegacyTask,
  summarizePrediction,
} from "./task-flow.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerStatusCommand(parent: Command): void {
  parent
    .command("status <kind> <taskId>")
    .description(
      `Get a TopView task's status; --wait/--download to resume it. Kinds: ${STATUS_KINDS.join(", ")}`,
    )
    .option("--wait", "Poll until the task reaches a terminal status")
    .option("--download", "Download outputs once finished")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "1800000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (rawKind: string, taskId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const kind = parseStatusKind(rawKind);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const report = { download: Boolean(opts.download), output: opts.output, logger };

      if (kind === "platform") {
        const id = assertPredictionId(taskId);
        const client = createTopviewPlatformClient();
        if (opts.wait) {
          try {
            await completePrediction(client, id, { waitTimeoutMs, ...report });
          } catch (error) {
            if (
              !opts.download &&
              (error instanceof TopviewPredictionError ||
                error instanceof TopviewPaymentRequiredError)
            ) {
              console.log(JSON.stringify(summarizePrediction(error.prediction), null, 2));
            }
            throw error;
          }
          return;
        }
        const prediction = await client.getPrediction(id);
        logCharge(logger, prediction);
        if (prediction.status === "completed" && opts.download) {
          await reportOutputs(id, prediction.outputs, summarizePrediction(prediction), {
            ...report,
            retryHint: `Retry: multix topview status platform ${id} --download`,
          });
          return;
        }
        console.log(JSON.stringify(summarizePrediction(prediction), null, 2));
        if (!isPredictionStopped(prediction.status)) {
          logger.info(`Still running. Resume with: ${resumeCommand("platform", id)}`);
        } else {
          assertPredictionCompleted(prediction);
        }
        return;
      }

      const id = assertLegacyId(taskId);
      const client = createTopviewClient();
      if (opts.wait) {
        try {
          await completeLegacyTask(client, kind, id, { waitTimeoutMs, ...report });
        } catch (error) {
          if (!opts.download && error instanceof TopviewTaskError) {
            console.log(JSON.stringify(summarizeLegacyTask(error.task), null, 2));
          }
          throw error;
        }
        return;
      }
      const task = await client.getTask(kind, id);
      if (task.costCredit !== undefined) logger.info(`Credits charged: ${task.costCredit}`);
      if (task.status === "success" && opts.download) {
        await reportOutputs(id, task.outputs, summarizeLegacyTask(task), {
          ...report,
          retryHint: `Retry: multix topview status ${kind} ${id} --download`,
        });
        return;
      }
      console.log(JSON.stringify(summarizeLegacyTask(task), null, 2));
      if (!isLegacyTerminal(task.status)) {
        logger.info(`Still running. Resume with: ${resumeCommand(kind, id)}`);
      } else if (task.status === "fail") {
        throw new TopviewTaskError(task);
      }
    });
}
