/**
 * multix fal run <model> — generic runner for any fal.ai model.
 * Submits, polls to completion, then prints or downloads any media URLs found
 * in the result payload. `--file field=path` uploads local media to fal
 * storage first and puts its URL in the input; `--detach` returns as soon as
 * fal has queued the job, printing a receipt for `fal status` / `fal result`.
 * `--detach` and `--receipt` save that receipt to disk (see request-receipt.ts).
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient, requireFalKey } from "../client.js";
import { applyFileFlags, parseFileFlags } from "../local-files.js";
import {
  downloadResultMedia,
  extractMediaRefs,
  parseInputArg,
  submitOrDetach,
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
    .option(
      "--receipt <path>",
      "Save the request receipt to this file (--detach saves to ~/.multix/fal/requests/ by default)",
    )
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

      const submit = await submitOrDetach({
        client,
        model,
        input,
        logger,
        detach: opts.detach,
        receiptPath: opts.receipt,
      });
      if (!submit) return;

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

      const refs = extractMediaRefs(result);
      if (refs.length === 0) {
        logger.warn("No media URLs found in result; printing raw JSON.");
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
      const saved = await downloadResultMedia(refs, outDir, submit.request_id, logger);
      if (saved.length === 0) {
        logger.error(`Found ${refs.length} media URL(s) but none downloaded successfully.`);
        process.exit(1);
      }
      console.log(`\nDownloaded ${saved.length} file(s):`);
      for (const f of saved) console.log(`  ${f}`);
    });
}
