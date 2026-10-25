/**
 * multix fal run <model> — generic runner for any fal.ai model.
 * Submits, polls to completion, then prints or downloads any media URLs found
 * in the result payload. `--file key=path` uploads local files to fal storage
 * first; `--detach` returns right after the queue accepts the job, with a
 * receipt saved for `fal status` / `fal result`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient } from "../client.js";
import { parseFileAssignments, resolveFileAssignments } from "../node-input-files.js";
import { buildReceipt, defaultReceiptPath, writeReceipt } from "../receipt.js";
import {
  downloadResultMedia,
  extractMediaUrls,
  parseInputArg,
  submitAndWait,
  submitFalRequest,
} from "../run-helpers.js";

const collect = (value: string, previous: string[] = []) => [...previous, value];

interface RunOptions {
  input: string;
  file?: string[];
  detach?: boolean;
  receipt?: string;
  download: boolean;
  outputDir?: string;
  waitTimeout: string;
  verbose?: boolean;
}

/** Download directory: --output-dir (created) or the default output dir. */
export function resolveDownloadDir(outputDir: string | undefined): string {
  if (!outputDir) return getOutputDir();
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerFalRunCommand(parent: Command): void {
  parent
    .command("run <model>")
    .description("Run any fal.ai model by id (e.g. fal-ai/flux/schnell)")
    .requiredOption("--input <json>", "JSON input, or @path/to/file.json")
    .option(
      "--file <key=path>",
      "Set input <key> to a local file (uploaded to fal storage) or a URL; repeatable",
      collect,
    )
    .option("--detach", "Submit only: print a JSON receipt and return without waiting")
    .option(
      "--receipt <path>",
      "With --detach: receipt file (default ~/.multix/fal/requests/<id>.json)",
    )
    .option("--no-download", "Skip downloading media; print result JSON only")
    .option("--output-dir <dir>", "Directory for downloaded media (default: MULTIX_OUTPUT_DIR)")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (model: string, opts: RunOptions) => {
      // A detached run prints only the receipt JSON on stdout.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.detach });
      if (opts.receipt !== undefined && !opts.detach) {
        throw new ValidationError("--receipt needs --detach");
      }
      if (opts.detach && (opts.outputDir !== undefined || opts.download === false)) {
        logger.warn(
          "--detach does not download: --output-dir and --no-download apply to `fal result`.",
        );
      }
      const assignments = parseFileAssignments(opts.file);
      const parsed = parseInputArg(opts.input);
      const input = assignments.length
        ? await resolveFileAssignments(parsed, assignments, { logger })
        : parsed;

      logger.info(`Submitting to ${model}...`);
      if (opts.detach) {
        const submitted = await submitFalRequest(createFalClient(), model, input, logger);
        const receipt = buildReceipt({
          model,
          requestId: submitted.request_id,
          queuePosition: submitted.queue_position,
          input,
        });
        try {
          receipt.receipt_path = writeReceipt(
            receipt,
            opts.receipt ?? defaultReceiptPath(submitted.request_id),
          );
        } catch (e) {
          // The job is already queued (and billed): report it rather than fail.
          logger.warn(
            `Could not save the receipt (${e instanceof Error ? e.message : e}); keep request_id ${submitted.request_id}.`,
          );
        }
        logger.success(`Queued ${submitted.request_id}. Next: ${receipt.next.result}`);
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }

      const { requestId, result } = await submitAndWait({
        model,
        input,
        logger,
        waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 480_000,
      });

      if (opts.download === false) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const urls = extractMediaUrls(result);
      if (urls.length === 0) {
        logger.warn("No media URLs found in result; printing raw JSON.");
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const outDir = resolveDownloadDir(opts.outputDir);
      const saved = await downloadResultMedia(urls, outDir, requestId, logger);
      if (saved.length === 0) {
        logger.error(`Found ${urls.length} media URL(s) but none downloaded successfully.`);
        process.exit(1);
      }
      console.log(`\nDownloaded ${saved.length} file(s):`);
      for (const f of saved) console.log(`  ${f}`);
    });
}
