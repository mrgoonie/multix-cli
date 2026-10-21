/**
 * Shared submit → wait → report flow for `replicate run|image|video|status`.
 * Waits with bounded polling by default; `--async` returns right after submit
 * with commands to resume or cancel the job by id.
 */

import { type Command, InvalidArgumentError, Option } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { type ReplicateClient, assertSucceeded } from "../client.js";
import { describeModelRef, isTerminalStatus } from "../models.js";
import { saveMediaOutputs } from "../node-outputs.js";
import { extractOutput, summarizePrediction } from "../output.js";
import type { ModelRef, ReplicatePrediction } from "../types.js";

export interface FlowOptions {
  async?: boolean;
  wait?: boolean;
  waitTimeout: string;
  /** undefined (no flag) and true both mean "download". */
  download?: boolean;
  output?: string;
  /** Seconds for `Prefer: wait=N`, already validated by parsePreferWaitSeconds. */
  preferWait?: number;
  verbose?: boolean;
}

export const DEFAULT_PREFER_WAIT_SECONDS = 60;

/**
 * Commander parser for `--prefer-wait [seconds]`: an integer from 1 to 60.
 * A bare flag (last argument, or followed by another option) means 60. Any
 * other value is rejected, so a prompt placed right after the flag fails
 * loudly instead of being swallowed as the wait time.
 */
export function parsePreferWaitSeconds(raw: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > 60) {
    throw new InvalidArgumentError(
      `Expected an integer number of seconds from 1 to 60 (a bare --prefer-wait means ${DEFAULT_PREFER_WAIT_SECONDS}); put the prompt before the flag.`,
    );
  }
  return n;
}

/** Register the submit/wait/download flags shared by run, image, and video. */
export function addFlowOptions(cmd: Command, defaultTimeoutMs: number): Command {
  return cmd
    .option("--async", "Submit and return immediately with the prediction id")
    .option("--wait", "Wait for a terminal status (default unless --async)")
    .addOption(
      new Option(
        "--prefer-wait [seconds]",
        "Ask Replicate to hold the create request open for 1-60s (bare flag: 60); keeps polling if still running",
      )
        .argParser(parsePreferWaitSeconds)
        .preset(String(DEFAULT_PREFER_WAIT_SECONDS)),
    )
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", String(defaultTimeoutMs))
    .option("--download", "Download media outputs (default)")
    .option("--no-download", "Print output URLs instead of downloading")
    .option("--output <path>", "Output file path, or a directory for multiple outputs")
    .option("-v, --verbose", "Verbose logging");
}

export function parsePositiveInt(raw: string, flag: string, max?: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || (max !== undefined && n > max)) {
    throw new ValidationError(
      `${flag} must be a positive integer${max !== undefined ? ` up to ${max}` : ""}`,
    );
  }
  return n;
}

export function resumeCommand(id: string): string {
  return `multix replicate status ${id} --wait --download`;
}

function printAsyncHandle(prediction: ReplicatePrediction): void {
  console.log(`Prediction submitted: ${prediction.id} (status: ${prediction.status})`);
  console.log(`  Check:  multix replicate status ${prediction.id}`);
  console.log(`  Resume: ${resumeCommand(prediction.id)}`);
  console.log(`  Cancel: multix replicate cancel ${prediction.id}`);
}

export interface ReportOptions {
  download: boolean;
  output?: string;
  logger: Logger;
  /** Post-process saved files (e.g. WebP conversion) before they are listed. */
  finalize?: (files: string[]) => string[];
}

/** Print text outputs and download (or list) media outputs of a succeeded prediction. */
export async function reportOutputs(
  prediction: ReplicatePrediction,
  opts: ReportOptions,
): Promise<string[]> {
  const { media, texts } = extractOutput(prediction.output);
  for (const text of texts) console.log(text);

  if (media.length === 0) {
    if (texts.length === 0) console.log(JSON.stringify(summarizePrediction(prediction), null, 2));
    return [];
  }
  if (!opts.download) {
    for (const m of media) console.log(m.url);
    return [];
  }

  const saved = await saveMediaOutputs(prediction.id, media, {
    outDir: opts.output ? "" : getOutputDir(),
    output: opts.output,
    logger: opts.logger,
    retryHint: `Retry while the output URLs are live: multix replicate status ${prediction.id} --download (or print the URLs to fetch elsewhere: multix replicate status ${prediction.id})`,
  });
  const finals = opts.finalize ? opts.finalize(saved) : saved;
  console.log(`\nSaved ${finals.length} file(s) from prediction ${prediction.id}:`);
  for (const f of finals) console.log(`  ${f}`);
  return finals;
}

/** Wait for a terminal status, fail loudly unless it succeeded, then report outputs. */
export async function completePrediction(
  client: ReplicateClient,
  prediction: ReplicatePrediction | string,
  opts: { waitTimeoutMs: number; logger: Logger } & Omit<ReportOptions, "logger">,
): Promise<string[]> {
  const id = typeof prediction === "string" ? prediction : prediction.id;
  let lastStatus = typeof prediction === "string" ? "" : prediction.status;
  if (typeof prediction === "string" || !isTerminalStatus(prediction.status)) {
    opts.logger.info(`Waiting for prediction ${id}...`);
  }
  const final = await client.waitForPrediction(prediction, {
    timeoutMs: opts.waitTimeoutMs,
    resumeHint: `Resume with: ${resumeCommand(id)}`,
    onPoll: (p, attempt) => {
      if (p.status !== lastStatus) opts.logger.debug(`attempt ${attempt}: ${p.status}`);
      lastStatus = p.status;
    },
  });
  assertSucceeded(final);
  opts.logger.success(`Prediction ${final.id} succeeded`);
  return reportOutputs(final, opts);
}

/** Submit a prediction, then either print the async handle or wait and report. */
export async function executePrediction(params: {
  client: ReplicateClient;
  model: ModelRef;
  input: Record<string, unknown>;
  opts: FlowOptions;
  logger: Logger;
  finalize?: (files: string[]) => string[];
}): Promise<void> {
  const { client, model, input, opts, logger } = params;
  if (opts.async && opts.wait)
    throw new ValidationError("--async and --wait are mutually exclusive");
  if (opts.async && opts.preferWait !== undefined) {
    throw new ValidationError("--async and --prefer-wait are mutually exclusive");
  }
  const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");

  logger.info(`Submitting to Replicate ${describeModelRef(model)}...`);
  const prediction = await client.createPrediction({
    model,
    input,
    preferWaitSeconds: opts.preferWait,
  });

  if (opts.async) {
    printAsyncHandle(prediction);
    return;
  }
  logger.info(`Prediction ${prediction.id} (status: ${prediction.status})`);
  await completePrediction(client, prediction, {
    waitTimeoutMs,
    logger,
    download: opts.download !== false,
    output: opts.output,
    finalize: params.finalize,
  });
}
