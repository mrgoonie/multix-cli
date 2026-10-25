/**
 * Shared `--input` / `--file` / `--expires-in` handling for `fal run` and
 * `fal submit`: parse the JSON payload, then upload the named local files and
 * put their URLs into it.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { requireFalKey } from "../client.js";
import { applyFileFields, parseFileSpecs } from "../local-files.js";
import { parseInputArg } from "../run-helpers.js";
import { FAL_EXPIRY_PRESETS, parseFalExpiry } from "../storage.js";

export interface JobInputOptions {
  input?: string;
  file: string[];
  expiresIn?: string;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Add `--input`, `--file` and `--expires-in` to a command. */
export function addJobInputOptions(cmd: Command): Command {
  return cmd
    .option("--input <json>", "JSON input, or @path/to/file.json")
    .option(
      "--file <field=path>",
      "Upload a local file to fal storage and set its URL at <field> (dotted path); repeatable. URLs are used as given",
      collect,
      [],
    )
    .option(
      "--expires-in <ttl>",
      `Ask fal to delete the uploads after ${FAL_EXPIRY_PRESETS.filter((p) => p !== "never").join("/")} or N seconds`,
    );
}

/** Build the job payload; uploads happen here, before anything is submitted. */
export async function prepareJobInput(
  opts: JobInputOptions,
  logger: Logger,
): Promise<{ input: Record<string, unknown>; uploadedFields: string[] }> {
  if (!opts.input && opts.file.length === 0) {
    throw new ValidationError("Provide --input <json|@file> and/or --file field=path");
  }
  const input = opts.input ? parseInputArg(opts.input) : {};
  const specs = parseFileSpecs(opts.file);
  const expiresInSeconds = opts.expiresIn ? parseFalExpiry(opts.expiresIn) : undefined;
  if (specs.length === 0) return { input, uploadedFields: [] };
  const uploads = await applyFileFields(input, specs, {
    apiKey: requireFalKey(),
    expiresInSeconds,
    logger,
  });
  return { input, uploadedFields: uploads.map((u) => u.field) };
}
