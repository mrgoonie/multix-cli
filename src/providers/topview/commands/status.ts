/**
 * `topview status <kind> <taskId>` (Legacy API): inspect or resume a task
 * without creating a new one. Kinds: m2v, video-avatar, remove-bg,
 * product-avatar-replace, product-avatar-video, anyshoot-try-on,
 * anyshoot-background. Prints a JSON summary (output URLs without their signed
 * query strings); --wait polls until finished; --download saves the outputs.
 * stdout carries only the result; progress, cost and next-step hints go to
 * stderr. A failed task exits non-zero. There is no cancel endpoint.
 */

import type { Command } from "commander";
import { nameJob } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { TopviewTaskError } from "../errors.js";
import { isLegacyTaskDone } from "../legacy-client.js";
import { LEGACY_TASK_KIND_NAMES, assertLegacyId, assertLegacyTaskKind } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import {
  completeLegacyTask,
  legacyResumeCommand,
  logLegacyCost,
  logNextStep,
  parsePositiveInt,
  reportLegacyOutputs,
  summarizeLegacyTask,
} from "./task-flow.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout: string;
  verbose?: boolean;
}

export function registerTopviewStatusCommand(parent: Command): void {
  parent
    .command("status <kind> <taskId>")
    .description(
      `Legacy API: get a task's status; --wait/--download to resume it. Kinds: ${LEGACY_TASK_KIND_NAMES.join(", ")}`,
    )
    .option("--wait", "Poll until the task finishes")
    .option("--download", "Download outputs once succeeded")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "1800000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (kindRaw: string, taskId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const kind = assertLegacyTaskKind(kindRaw);
      const id = assertLegacyId(taskId);
      // Name the job read here, so a failed read still joins its operation.
      nameJob(id);
      const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
      if (opts.output !== undefined && !opts.download) {
        throw new ValidationError("--output needs --download");
      }
      const client = createTopviewLegacyClient();

      if (opts.wait) {
        try {
          await completeLegacyTask(client, kind, id, {
            waitTimeoutMs,
            logger,
            download: Boolean(opts.download),
            output: opts.output,
          });
        } catch (error) {
          // A failed task still gets its JSON summary (errorMsg, cost).
          if (!opts.download && error instanceof TopviewTaskError) {
            console.log(JSON.stringify(summarizeLegacyTask(error.task), null, 2));
          }
          throw error;
        }
        return;
      }

      const task = await client.getTask(kind, id);
      logLegacyCost(logger, task);
      const done = isLegacyTaskDone(task);
      if (done && task.status === "success" && opts.download) {
        await reportLegacyOutputs(task, { download: true, output: opts.output, logger });
        logNextStep(logger, task);
        return;
      }
      console.log(JSON.stringify(summarizeLegacyTask(task), null, 2));
      if (!done) {
        logger.info(`Still running. Resume with: ${legacyResumeCommand(kind, task.taskId)}`);
      } else if (task.status !== "success") {
        throw new TopviewTaskError(task);
      } else {
        logNextStep(logger, task);
      }
    });
}
