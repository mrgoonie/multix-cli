/**
 * multix runway cancel <taskId> — cancel a pending or running task
 * (DELETE /v1/tasks/{id}). The same endpoint deletes a finished task and its
 * outputs, so a task that is already finished is only deleted with --delete.
 * Runway has no cancel-only endpoint: a task that finishes in the moment
 * between the status check and the request is deleted too.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createRunwayClient } from "../node-client.js";

export function registerRunwayCancelCommand(parent: Command): void {
  parent
    .command("cancel <taskId>")
    .description("Cancel a running Runway task (--delete also removes a finished task)")
    .option("--delete", "Delete the task and its outputs if it already finished")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: { delete?: boolean; verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createRunwayClient();
      const result = await client.cancelTask(taskId, { allowDelete: Boolean(opts.delete) });
      const { task } = result;
      if (result.action === "cancelled") {
        logger.success(
          `Cancel sent for task ${task.id} (was ${task.status}); if it finished meanwhile, Runway deleted it`,
        );
      } else if (result.action === "deleted") {
        logger.success(`Task ${task.id} deleted (was ${task.status})`);
      } else {
        logger.warn(
          `Task ${task.id} already finished (status: ${task.status}); nothing to cancel. Pass --delete to delete it and its outputs`,
        );
      }
    });
}
