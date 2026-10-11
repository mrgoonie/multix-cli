/**
 * multix heygen status <id> --type agent|video|translation|lipsync|model-video
 * Operation-aware status. `--type agent` takes a Video Agent session ID and
 * follows it to its video; `--type video` takes a video ID. Resumable after a
 * restart because all state lives on HeyGen's side.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  assertJobSucceeded,
  getJobState,
  resumeCommand,
  waitForJob,
} from "../jobs.js";
import { JOB_KINDS } from "../models.js";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  type WaitFlowOptions,
  completeJobs,
  createHeygenClientFromEnv,
  parsePositiveInt,
  summarizeState,
} from "../node-helpers.js";
import { oneOf } from "../request-builders.js";

interface StatusOpts extends WaitFlowOptions {
  type: string;
  raw?: boolean;
}

export function registerHeygenStatusCommand(parent: Command): void {
  parent
    .command("status <id>")
    .description("Check (or wait for and download) a HeyGen job by ID")
    .option(
      "--type <type>",
      "agent (session ID) | video | translation | lipsync | model-video",
      "video",
    )
    .option("--wait", "Poll until the job finishes")
    .option("--download", "Download the output when complete (implies --wait)")
    .option("--wait-timeout <ms>", "Max time to wait", "1800000")
    .option(
      "--poll-interval <ms>",
      "Initial poll interval (backs off to 30s)",
      String(DEFAULT_POLL_INTERVAL_MS),
    )
    .option("--output <path>", "Output file path (with --download)")
    .option("--captions", "Also download the caption/subtitle file when available")
    .option(
      "--burn-captions",
      "Video: use the burned-in caption render (captioned_video_url); fails if absent",
    )
    .option("--no-thumb", "Skip downloading the video thumbnail")
    .option("--json", "Print a JSON summary")
    .option("--raw", "Print the raw API payload (includes signed URLs) instead of the summary")
    .option("-v, --verbose", "Verbose logging")
    .action(async (id: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const kind = oneOf(opts.type, JOB_KINDS, "--type") ?? "video";
      const client = createHeygenClientFromEnv();

      if (opts.download) {
        await completeJobs(client, kind, [id], { ...opts, async: false, download: true }, logger);
        return;
      }

      const read = { burnCaptions: opts.burnCaptions };
      const state = opts.wait
        ? await waitForJob(client, kind, id, {
            ...read,
            timeoutMs: parsePositiveInt(
              opts.waitTimeout,
              "--wait-timeout",
              DEFAULT_WAIT_TIMEOUT_MS,
            ),
            intervalMs: parsePositiveInt(
              opts.pollInterval,
              "--poll-interval",
              DEFAULT_POLL_INTERVAL_MS,
            ),
            resumeHint: `Resume with: ${resumeCommand(kind, id, read)}`,
          })
        : await getJobState(client, kind, id, read);
      console.log(JSON.stringify(opts.raw ? state.raw : summarizeState(state), null, 2));
      if (state.done) assertJobSucceeded(state);
      else if (!opts.json) logger.info(`Still ${state.status}. Re-run with --wait to poll.`);
    });
}
