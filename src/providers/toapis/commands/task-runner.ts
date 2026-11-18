/**
 * Shared flow for ToAPIs generation commands: submit, track the job, wait,
 * then download each output. ToAPIs keeps outputs for 30 days, so results are
 * downloaded right away unless --no-download is passed.
 */

import path from "node:path";
import type { Command } from "commander";
import { trackInFlight } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { downloadFile } from "../../../core/http-client.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { redactUrl } from "../../../core/redact.js";
import {
  type ToapisClient,
  ToapisTaskFailedError,
  settledCostUsd,
  taskOutputUrls,
} from "../client.js";
import type { ToapisMediaKind, ToapisTask } from "../types.js";

export interface RunOpts {
  async?: boolean;
  waitTimeout?: string;
  output?: string;
  /** commander `--no-download` sets false. */
  download?: boolean;
  verbose?: boolean;
}

export function addRunOptions(cmd: Command, waitTimeoutMs: number): Command {
  return cmd
    .option("--async", "Submit and exit; print the task id (resume with `toapis status`)")
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(waitTimeoutMs))
    .option("--output <path>", "Output file (single output) or directory")
    .option("--no-download", "Do not download media; print output URLs instead")
    .option("-v, --verbose", "Verbose logging");
}

export function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function resumeCommand(kind: ToapisMediaKind, id: string): string {
  return `multix toapis status ${id} --kind ${kind} --wait`;
}

const EXT: Record<string, string> = {
  mp4: ".mp4",
  mov: ".mov",
  png: ".png",
  jpeg: ".jpg",
  jpg: ".jpg",
  webp: ".webp",
};

function outputPaths(
  task: ToapisTask,
  kind: ToapisMediaKind,
  urls: string[],
  output?: string,
): string[] {
  const fallbackExt = kind === "video" ? ".mp4" : ".png";
  const extOf = (i: number) => {
    const fmt = task.result?.data?.[i]?.format?.toLowerCase();
    const fromUrl = path.extname(new URL(urls[i] as string).pathname).toLowerCase();
    return (fmt && EXT[fmt]) || (/^\.[a-z0-9]{2,4}$/.test(fromUrl) ? fromUrl : fallbackExt);
  };
  if (output && urls.length === 1 && path.extname(output)) return [output];
  const dir = output ?? getOutputDir();
  const stem = `toapis-${kind}-${task.id.slice(-8)}-${outputStamp()}`;
  return urls.map((_, i) =>
    path.join(dir, `${stem}${urls.length > 1 ? `-${i + 1}` : ""}${extOf(i)}`),
  );
}

/** Redacted copy of a task, safe to print (signed output URLs removed). */
export function printableTask(task: ToapisTask): ToapisTask {
  return {
    ...task,
    result: task.result && {
      ...task.result,
      data: task.result.data?.map((d) => ({
        ...d,
        url: d.url && redactUrl(d.url),
        fallback_url: d.fallback_url && redactUrl(d.fallback_url),
        last_frame_url: d.last_frame_url && redactUrl(d.last_frame_url),
      })),
    },
  };
}

/** Download (or list) a finished task's outputs and print a summary. */
export async function finishTask(
  task: ToapisTask,
  kind: ToapisMediaKind,
  opts: RunOpts,
  logger: Logger,
): Promise<string[]> {
  if (task.status === "failed") throw new ToapisTaskFailedError(task);
  const urls = taskOutputUrls(task);
  if (urls.length === 0) {
    throw new ValidationError(`ToAPIs task ${task.id} completed without an output URL`);
  }
  const cost = settledCostUsd(task);
  const saved: string[] = [];
  if (opts.download !== false) {
    const dests = outputPaths(task, kind, urls, opts.output);
    for (const [i, url] of urls.entries()) {
      const dest = dests[i] as string;
      await downloadFile(url, dest, 300_000);
      logger.success(`Saved ${dest}`);
      saved.push(dest);
    }
  }
  console.log(`\nTask: ${task.id}`);
  if (cost !== undefined)
    console.log(`Cost: $${cost.toFixed(6)} (billing ${task.billing?.status})`);
  else console.log("Cost: not settled yet (check later with `multix toapis status`)");
  if (opts.download === false) for (const url of urls) console.log(url);
  else for (const p of saved) console.log(`Saved: ${p}`);
  return saved;
}

/** Submit a body, then wait and finish unless --async. */
export async function runTask(
  client: ToapisClient,
  kind: ToapisMediaKind,
  body: Record<string, unknown>,
  opts: RunOpts,
  logger: Logger,
  defaultTimeoutMs: number,
): Promise<void> {
  const timeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout") ?? defaultTimeoutMs;
  logger.info(`Submitting ToAPIs ${kind} task (${String(body.model)})`);
  const submitted = await client.submit(kind, body);
  const resume = resumeCommand(kind, submitted.id);
  trackInFlight(submitted.id, resume);
  if (opts.async) {
    console.log(submitted.id);
    console.error(`Poll with: ${resume}`);
    return;
  }
  const task = await client.waitForTask(kind, submitted.id, {
    timeoutMs,
    resumeHint: resume,
    onPoll: (t) => logger.debug(`status ${t.status || "queued"} ${t.progress ?? 0}%`),
  });
  await finishTask(task, kind, opts, logger);
}
