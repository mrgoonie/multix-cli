/**
 * multix heygen template <template-id> --input <json|@file> — generate a video
 * from a HeyGen Studio template via POST /v3/templates/{id}. The input is
 * either the full request body or just the `variables` map.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  completeJobs,
  createHeygenClientFromEnv,
} from "../node-helpers.js";

interface TemplateOpts extends WaitFlowOptions {
  input: string;
  title?: string;
}

/** Accept `{ variables: {...}, ... }` or a bare variables map. */
export function templateBody(
  input: Record<string, unknown>,
  title?: string,
): Record<string, unknown> {
  const body =
    "variables" in input ? { ...input } : ({ variables: input } as Record<string, unknown>);
  const vars = body.variables;
  if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
    throw new ValidationError("Template input must contain a `variables` object");
  }
  if (title) body.title = title;
  return body;
}

export function registerHeygenTemplateCommand(parent: Command): void {
  const cmd = parent
    .command("template <template-id>")
    .description("Generate a video from a HeyGen Studio template by filling its variables")
    .requiredOption(
      "--input <json>",
      "Variables map or full request body, inline JSON or @path/to/vars.json",
    )
    .option("--title <text>", "Video title");
  addWaitOptions(cmd).action(async (templateId: string, opts: TemplateOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const body = templateBody(parseJsonInput(opts.input), opts.title);
    const client = createHeygenClientFromEnv();
    logger.info(`Generating from template ${templateId}...`);
    const video = await client.generateFromTemplate(templateId, body);
    await completeJobs(client, "video", [video.id], opts, logger);
  });
}
