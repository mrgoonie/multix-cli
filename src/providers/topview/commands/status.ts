/**
 * multix topview status <taskId> --task <kind> — resume a task on either API.
 * One GET by default; --wait polls (bounded) until it finishes; --download
 * (implies --wait) saves the results under the same deterministic names a
 * submit uses, skipping files already saved. TopView documents no cancel
 * endpoint on either API, so none is offered.
 */

import type { Command } from "commander";
import { trackInFlight } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { TopviewTaskFailedError, assertValidTaskId } from "../legacy-client.js";
import { STATUS_TASK_KINDS, type StatusTaskKind, isLegacyTaskKind } from "../models.js";
import { TopviewPlatformFailedError, assertValidPredictionId } from "../platform-client.js";
import {
  createLegacyClientFromEnv,
  createPlatformClientFromEnv,
  createTopviewLogger,
} from "./env.js";
import {
  type TaskCliOpts,
  exitOnInterrupt,
  finishLegacyTask,
  finishPlatformTask,
  parseTimeoutMs,
  recordPlatformCharge,
  resumeCommand,
} from "./task-runner.js";

const STATUS_WAIT_MS = 1_800_000;

interface StatusFlags extends TaskCliOpts {
  task: string;
  wait?: boolean;
}

function taskKind(raw: string): StatusTaskKind {
  if (!(STATUS_TASK_KINDS as readonly string[]).includes(raw)) {
    throw new ValidationError(
      `--task must be one of ${STATUS_TASK_KINDS.join(", ")} (got "${raw}")`,
    );
  }
  return raw as StatusTaskKind;
}

async function waitFor<T>(
  id: string,
  resume: string,
  poll: (resumeHint: string) => Promise<T>,
): Promise<T> {
  // A stopped wait leaves the task running: report how to resume it.
  trackInFlight(id, resume);
  return exitOnInterrupt(() => poll(`Resume with: ${resume}`), {
    message: `Cancelled while waiting on task ${id}; it keeps running. Resume with: ${resume}`,
  });
}

async function platformStatus(id: string, opts: StatusFlags, logger: Logger): Promise<void> {
  assertValidPredictionId(id);
  const client = createPlatformClientFromEnv();
  const wait = Boolean(opts.wait || opts.download);
  const resume = resumeCommand("platform", id, opts.output);
  const prediction = wait
    ? await waitFor(id, resume, (resumeHint) =>
        client.waitForPrediction(id, {
          timeoutMs: parseTimeoutMs(opts.waitTimeout, STATUS_WAIT_MS),
          resumeHint,
          onPoll: (p, n) => logger.debug(`poll ${n}: ${p.status}`),
        }),
      )
    : await client.getPrediction(id);
  if (!opts.download) {
    recordPlatformCharge(prediction);
    console.log(JSON.stringify(prediction, null, 2));
    if (prediction.status === "failed") throw new TopviewPlatformFailedError(prediction);
    return;
  }
  await finishPlatformTask(prediction, { logger, opts, taskId: id, hint: "video" });
}

async function legacyStatus(
  kind: Exclude<StatusTaskKind, "platform">,
  id: string,
  opts: StatusFlags,
  logger: Logger,
): Promise<void> {
  assertValidTaskId(id);
  if (!isLegacyTaskKind(kind)) throw new ValidationError(`Unknown task kind ${kind}`);
  const client = createLegacyClientFromEnv();
  const wait = Boolean(opts.wait || opts.download);
  const resume = resumeCommand(kind, id, opts.output);
  const task = wait
    ? await waitFor(id, resume, (resumeHint) =>
        client.waitForTask(kind, id, {
          timeoutMs: parseTimeoutMs(opts.waitTimeout, STATUS_WAIT_MS),
          resumeHint,
          onPoll: (t, n) => logger.debug(`poll ${n}: ${t.status}`),
        }),
      )
    : await client.getTask(kind, id);
  if (!opts.download) {
    console.log(JSON.stringify(task, null, 2));
    if (task.status === "fail") throw new TopviewTaskFailedError(task);
    return;
  }
  const hint = kind.startsWith("anyshoot") || kind === "product-avatar-image" ? "image" : "video";
  await finishLegacyTask(kind, task, { logger, opts, taskId: id, hint });
}

export function registerStatusCommand(parent: Command): void {
  parent
    .command("status <taskId>")
    .description(
      "Get a TopView task (legacy or Platform); --wait to poll, --download to save results",
    )
    .requiredOption("--task <kind>", `Task kind: ${STATUS_TASK_KINDS.join(", ")}`)
    .option("--wait", "Poll until the task finishes")
    .option("--wait-timeout <ms>", "Max time to wait (with --wait)", String(STATUS_WAIT_MS))
    .option("--download", "Save results when finished (implies --wait)")
    .option("--output <path>", "Output file (single output) or directory (path without extension)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: StatusFlags) => {
      const kind = taskKind(opts.task);
      const logger = createTopviewLogger({ verbose: opts.verbose });
      if (kind === "platform") await platformStatus(taskId, opts, logger);
      else await legacyStatus(kind, taskId, opts, logger);
    });
}
