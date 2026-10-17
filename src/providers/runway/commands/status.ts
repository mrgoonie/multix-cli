/**
 * multix runway status <taskId> — inspect or resume a task without creating a
 * new one. Prints a JSON summary (output URLs without their signed query
 * strings); --wait polls to a terminal status; --download saves the outputs.
 * Signed output URLs are never printed here: `--no-download` on video/image
 * is the explicit way to get them. Progress and hints go to stderr so stdout
 * stays parseable JSON; --json keeps it JSON after --download as well.
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
  json?: boolean;
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
    .option("--json", "Print JSON only, also after --download (summary plus saved files)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const id = assertTaskId(taskId);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      const client = createRunwayClient();

      if (opts.wait) {
        await completeTask(client, id, {
          waitTimeoutMs,
          logger,
          download: Boolean(opts.download),
          output: opts.output,
          json: opts.json,
        });
        return;
      }

      const task = await client.getTask(id);
      if (task.status === "SUCCEEDED" && opts.download) {
        await reportOutputs(task, {
          download: true,
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
      }
    });
}
