/**
 * multix runway cancel <taskId> — cancel a pending or running task
 * (DELETE /v1/tasks/{id}). The same endpoint deletes a finished task and its
 * outputs, so a task already finished at the status check is only deleted
 * with an explicit --delete. Runway has no cancel-only verb: a task that
 * finishes between the check and the DELETE is deleted too.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { RunwayApiError } from "../client.js";
import { assertTaskId, isTerminalStatus } from "../models.js";
import { createRunwayClient } from "../node-client.js";

export function registerRunwayCancelCommand(parent: Command): void {
  parent
    .command("cancel <taskId>")
    .description("Cancel a running Runway task (--delete also removes a finished one)")
    .option("--delete", "Delete the task even when it already finished (removes its outputs)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: { delete?: boolean; verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const id = assertTaskId(taskId);
      const client = createRunwayClient();
      const task = await client.getTask(id);
      const finished = isTerminalStatus(task.status);
      if (finished && !opts.delete) {
        throw new ValidationError(
          `Task ${id} already finished (status: ${task.status}); nothing to cancel. Pass --delete to delete it and its outputs`,
        );
      }
      try {
        await client.deleteTask(id);
      } catch (error) {
        // Deleted between the status check and the DELETE: the goal is met.
        if (!(error instanceof RunwayApiError && error.status === 404)) throw error;
      }
      if (finished) logger.success(`Task ${id} deleted (was ${task.status})`);
      else logger.success(`Task ${id} canceled (was ${task.status})`);
    });
}
