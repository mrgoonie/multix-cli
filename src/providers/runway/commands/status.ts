/**
 * multix runway status <taskId> — inspect or resume a task without creating a
 * new one. Prints a JSON summary (output URLs without their signed query
 * strings); --wait polls to a terminal status; --download saves the outputs.
 * stdout carries only the result (that JSON, or the saved file list): progress,
 * cost and resume hints go to stderr, so `multix runway status <id> | jq`
 * parses whether or not the task has finished.
 * Signed output URLs are never printed here: `--no-download` on video/image
 * is the explicit way to get them.
 * FAILED/CANCELLED tasks exit non-zero.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { RunwayTaskError } from "../client.js";
import { assertTaskId, isTerminalStatus } from "../models.js";
import { createRunwayClient } from "../node-client.js";
import {
  completeTask,
  parsePositiveInt,
  reportOutputs,
  resumeCommand,
  summarizeTask,
} from "./task-flow.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerRunwayStatusCommand(parent: Command): void {
  parent
    .command("status <taskId>")
    .description("Get a Runway task's status; --wait/--download to resume it")
    .option("--wait", "Poll until the task reaches a terminal status")
    .option("--download", "Download outputs once succeeded")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertTaskId(taskId);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const client = createRunwayClient();

      if (opts.wait) {
        try {
          await completeTask(client, id, {
            waitTimeoutMs,
            logger,
            download: Boolean(opts.download),
            output: opts.output,
          });
        } catch (error) {
          // A FAILED/CANCELLED task still gets its JSON summary (failureCode, cost).
          if (!opts.download && error instanceof RunwayTaskError) {
            console.log(JSON.stringify(summarizeTask(error.task), null, 2));
          }
          throw error;
        }
        return;
      }

      const task = await client.getTask(id);
      if (task.status === "SUCCEEDED" && opts.download) {
        await reportOutputs(task, { download: true, output: opts.output, logger });
        return;
      }
      console.log(JSON.stringify(summarizeTask(task), null, 2));
      if (!isTerminalStatus(task.status)) {
        logger.info(`Still running. Resume with: ${resumeCommand(task.id)}`);
      } else if (task.status !== "SUCCEEDED") {
        throw new RunwayTaskError(task);
      }
    });
}
