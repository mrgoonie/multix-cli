/**
 * multix atlas run <modelId> --input <json|@file> — run any Atlas Cloud model
 * with its own documented payload, so newly published models work without a
 * CLI release. The endpoint comes from --type or the model's published schema.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { validateRawInput } from "../model-input.js";
import { ATLAS_MEDIA_KINDS } from "../models.js";
import type { AtlasMediaKind } from "../types.js";
import { createAtlasClientFromEnv, createAtlasLogger } from "./env.js";
import {
  type RunCliOpts,
  addRunOptions,
  assertEndpoint,
  beforeSubmit,
  executePrediction,
  loadModelSpec,
} from "./prediction-runner.js";

const RUN_WAIT_MS = 600_000;

interface RunFlags extends RunCliOpts {
  input: string;
  type?: string;
}

export function parseMediaKind(raw: string | undefined): AtlasMediaKind | undefined {
  if (raw === undefined) return undefined;
  const kind = raw.toLowerCase();
  if (!(ATLAS_MEDIA_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`Invalid --type "${raw}". Valid: ${ATLAS_MEDIA_KINDS.join(", ")}`);
  }
  return kind as AtlasMediaKind;
}

export function registerAtlasRunCommand(parent: Command): void {
  const run = parent
    .command("run <modelId>")
    .description("Run any Atlas Cloud model with a raw JSON payload (fields per the model's docs)")
    .requiredOption("--input <json>", "Model input as JSON, or @path/to/input.json")
    .option(
      "--type <type>",
      "Endpoint: image | video | audio (default: from the model's published schema; 3D uses image). Required with --no-validate or for models without a schema",
    );
  addRunOptions(run, { waitTimeoutMs: RUN_WAIT_MS, images: true, video: true }).action(
    async (modelId: string, opts: RunFlags) => {
      const logger = createAtlasLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
      const input = parseJsonInput(opts.input);
      if (input.model !== undefined && input.model !== modelId) {
        throw new ValidationError(
          `--input.model "${String(input.model)}" does not match <modelId> "${modelId}"`,
        );
      }
      const explicit = parseMediaKind(opts.type);
      const client = createAtlasClientFromEnv();
      const spec = await beforeSubmit(() => loadModelSpec(client, modelId, logger, opts.validate));
      const kind = explicit ?? spec?.endpoint;
      if (!kind) {
        throw new ValidationError(
          `Cannot determine the endpoint for ${modelId}; pass --type ${ATLAS_MEDIA_KINDS.join("|")}`,
        );
      }
      assertEndpoint(spec, kind, modelId);
      if (spec) {
        const unknown = validateRawInput(spec, input);
        if (unknown.length > 0) {
          logger.warn(
            `Fields not in ${modelId}'s published schema (sent anyway): ${unknown.join(", ")}`,
          );
        }
      }
      await executePrediction({
        client,
        logger,
        kind,
        model: modelId,
        body: input,
        opts,
        defaultWaitTimeoutMs: RUN_WAIT_MS,
        pollIntervalMs: kind === "video" ? 5000 : 3000,
      });
    },
  );
}
