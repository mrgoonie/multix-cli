/**
 * multix fal run <model> — generic runner for any fal.ai model.
 * Submits, polls to completion, then prints or downloads any media URLs found
 * in the result payload. `--file field=path` uploads local media to fal
 * storage first and puts its URL in the input; `--detach` returns as soon as
 * fal has queued the job, printing a receipt for `fal status` / `fal result`.
 * Every accepted submit is saved as a receipt (see request-receipt.ts).
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient, requireFalKey } from "../client.js";
import { applyFileFlags, parseFileFlags } from "../local-files.js";
import { type FalReceipt, buildReceipt, saveReceipt } from "../request-receipt.js";
import {
  downloadResultMedia,
  extractMediaUrls,
  parseInputArg,
  submitFalRequest,
  waitForFalResult,
} from "../run-helpers.js";

interface RunFlags {
  input?: string;
  file: string[];
  detach?: boolean;
  receipt?: string;
  download: boolean;
  outputDir?: string;
  waitTimeout: string;
  verbose?: boolean;
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** Save the receipt; a failure only warns, since the job is already queued and paid for. */
function persistReceipt(receipt: FalReceipt, file: string | undefined, logger: Logger): FalReceipt {
  try {
    const saved = saveReceipt(receipt, { file });
    logger.debug(`Receipt saved to ${saved}`);
    return { ...receipt, receipt_path: saved };
  } catch (e) {
    logger.warn(
      `Could not save the request receipt (${e instanceof Error ? e.message : e}); keep the request_id to resume.`,
    );
    return receipt;
  }
}

export function registerFalRunCommand(parent: Command): void {
  parent
    .command("run <model>")
    .description("Run any fal.ai model by id (e.g. fal-ai/flux/schnell)")
    .option("--input <json>", "JSON input, or @path/to/file.json")
    .option(
      "--file <field=path>",
      "Upload a local media file to fal storage and set its URL at this input field (repeatable; field[]=path appends)",
      collect,
      [],
    )
    .option("--detach", "Return after fal queues the job; print a receipt instead of waiting")
    .option("--receipt <path>", "Write the request receipt here (default ~/.multix/fal/requests/)")
    .option("--no-download", "Skip downloading media; print result JSON only")
    .option(
      "--output-dir <dir>",
      "Download media here (default MULTIX_OUTPUT_DIR or ./multix-output)",
    )
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (model: string, opts: RunFlags) => {
      // stdout carries only the result (JSON, receipt or saved paths); progress goes to stderr.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      if (opts.input === undefined && opts.file.length === 0) {
        throw new ValidationError("Provide --input <json> and/or --file <field=path>");
      }
      const input = opts.input === undefined ? {} : parseInputArg(opts.input);
      const fileFlags = parseFileFlags(opts.file);
      const client = createFalClient();
      await applyFileFlags(input, fileFlags, requireFalKey(), logger);

      logger.info(`Submitting to ${model}...`);
      const submit = await submitFalRequest(client, model, input, logger);
      const receipt = persistReceipt(
        buildReceipt({ model, requestId: submit.request_id, status: submit.status, input }),
        opts.receipt,
        logger,
      );

      if (opts.detach) {
        logger.success(`Queued fal request ${submit.request_id}`);
        logger.info(`Check: ${receipt.status_command}`);
        logger.info(`Fetch: ${receipt.result_command}`);
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }

      const result = await waitForFalResult({
        client,
        model,
        submit,
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

      const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
      const saved = await downloadResultMedia(urls, outDir, submit.request_id, logger);
      if (saved.length === 0) {
        logger.error(`Found ${urls.length} media URL(s) but none downloaded successfully.`);
        process.exit(1);
      }
      console.log(`\nDownloaded ${saved.length} file(s):`);
      for (const f of saved) console.log(`  ${f}`);
    });
}
