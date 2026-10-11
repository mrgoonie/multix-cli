/**
 * multix heygen run <operation> --input <json|@file> — advanced raw-JSON access
 * to documented v3 create operations. The payload is sent verbatim (no local
 * file upload), and each operation keeps its own response and status type.
 */

import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { unwrapData } from "../client.js";
import { HEYGEN_OPERATIONS } from "../models.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  completeJobs,
  createHeygenClientFromEnv,
  downloadOutput,
  inferExtension,
} from "../node-helpers.js";

interface RunOpts extends WaitFlowOptions {
  input: string;
}

/** Pull job IDs out of a create response according to the operation registry. */
export function extractJobIds(operation: string, data: Record<string, unknown>): string[] {
  const op = HEYGEN_OPERATIONS[operation];
  if (!op) return [];
  if (op.idsField) {
    const ids = data[op.idsField];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && !!x) : [];
  }
  const id = op.idField ? data[op.idField] : undefined;
  return typeof id === "string" && id ? [id] : [];
}

export function registerHeygenRunCommand(parent: Command): void {
  const names = Object.keys(HEYGEN_OPERATIONS);
  const cmd = parent
    .command("run <operation>")
    .description(`Send a raw v3 payload to a documented create operation: ${names.join(", ")}`)
    .requiredOption("--input <json>", "Request body, inline JSON or @path/to/payload.json");
  addWaitOptions(cmd).action(async (operation: string, opts: RunOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const op = HEYGEN_OPERATIONS[operation];
    if (!op) {
      throw new ValidationError(
        `Unknown operation "${operation}". Supported: ${names
          .map((n) => `${n} (${HEYGEN_OPERATIONS[n]?.description})`)
          .join("; ")}`,
      );
    }
    const body = parseJsonInput(opts.input);
    const client = createHeygenClientFromEnv();
    logger.info(`Calling ${op.description}...`);
    const json = await client.send<Record<string, unknown>>(op.path, {
      method: "POST",
      body,
      idempotencyKey: op.idempotent,
    });
    const data = unwrapData<Record<string, unknown>>(json, op.path);

    if (op.kind === null) {
      // Synchronous speech: download the returned audio unless told not to.
      const audioUrl = typeof data.audio_url === "string" ? data.audio_url : undefined;
      if (opts.download === false || !audioUrl) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const ext = inferExtension(audioUrl, "mp3");
      const dest = opts.output
        ? path.resolve(opts.output)
        : path.join(getOutputDir(), `heygen-speech-${Date.now()}.${ext}`);
      await downloadOutput(audioUrl, dest, "Re-run the command to generate a fresh URL.");
      console.log(`Saved: ${dest}`);
      return;
    }

    const ids = extractJobIds(operation, data);
    if (ids.length === 0) {
      throw new ValidationError(
        `HeyGen response for ${operation} had no job ID: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    await completeJobs(client, op.kind, ids, opts, logger);
  });
}
