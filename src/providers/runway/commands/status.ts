/**
 * multix runway status <taskId> — inspect or resume a task without paying
 * again. --wait polls to a terminal status; --download saves the outputs
 * (each read issues fresh signed URLs). FAILED/CANCELLED tasks exit non-zero.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { RunwayTaskError } from "../client.js";
import { isTerminalStatus } from "../models.js";
import { createRunwayClient } from "../node-client.js";
import { summarizeTask } from "../output.js";
import {
  type WaitFlags,
  addOutputOptions,
  completeTask,
  parsePositiveInt,
  reportSucceeded,
  resumeCommand,
} from "./task-flow.js";

interface StatusOpts extends WaitFlags {
  wait?: boolean;
}

export function registerRunwayStatusCommand(parent: Command): void {
  const cmd = parent
    .command("status <taskId>")
    .description("Get a Runway task's status; --wait/--download to resume it")
    .option("--wait", "Poll until the task reaches a terminal status");
  addOutputOptions(cmd, 900_000).action(async (taskId: string, opts: StatusOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.json });
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const client = createRunwayClient();
    const download = opts.download === true;

    if (opts.wait) {
      await completeTask(client, taskId, {
        waitTimeoutMs,
        logger,
        download,
        showSignedUrls: opts.download === false,
        output: opts.output,
        json: opts.json,
      });
      return;
    }

    const task = await client.getTask(taskId);
    if (task.status === "SUCCEEDED" && opts.download !== undefined) {
      await reportSucceeded(task, {
        download,
        showSignedUrls: opts.download === false,
        output: opts.output,
        json: opts.json,
        logger,
      });
      return;
    }
    console.log(JSON.stringify(summarizeTask(task), null, 2));
    if (!isTerminalStatus(task.status)) {
      logger.info(`Still running. Resume with: ${resumeCommand(task.id)}`);
    } else if (task.status !== "SUCCEEDED") {
      throw new RunwayTaskError(task);
    } else if (!opts.json) {
      logger.info(`Download with: multix runway status ${task.id} --download`);
    }
  });
}
