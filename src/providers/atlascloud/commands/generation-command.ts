/**
 * Driver shared by the convenience commands (image, video, audio, 3d):
 * load the model schema, map flags onto its fields, validate before any
 * upload or billable submit, upload local references, then run the prediction.
 */

import { type FieldRequest, buildModelInput } from "../model-input.js";
import type { OutputCategory } from "../prediction-output.js";
import type { AtlasMediaKind } from "../types.js";
import { createAtlasClientFromEnv, createAtlasLogger, resolveMediaRefs } from "./env.js";
import {
  type ExecuteResult,
  type RunCliOpts,
  assertEndpoint,
  beforeSubmit,
  executePrediction,
  loadModelSpec,
} from "./prediction-runner.js";

export interface GenerationCommandConfig {
  model: string;
  /** Expected endpoint; a model whose schema declares another one is rejected (see endpointFromSchema). */
  kind: AtlasMediaKind;
  /** Builds the flag -> field requests; called with raw refs (validation) and uploaded URLs. */
  requests: (refUrls: string[]) => FieldRequest[];
  /** Local paths or URLs to upload/pass through (images, audio). */
  refs?: string[];
  opts: RunCliOpts;
  hint: OutputCategory;
  defaultWaitTimeoutMs: number;
  pollIntervalMs: number;
  /** Accept whatever endpoint the schema declares (3D models live on generateImage today). */
  endpointFromSchema?: boolean;
}

export async function runGenerationCommand(cfg: GenerationCommandConfig): Promise<ExecuteResult> {
  const logger = createAtlasLogger({
    verbose: cfg.opts.verbose,
    stdoutReserved: cfg.opts.async,
  });
  const client = createAtlasClientFromEnv();
  const { kind, body } = await beforeSubmit(async () => {
    const spec = await loadModelSpec(client, cfg.model, logger, cfg.opts.validate);
    const kind = cfg.endpointFromSchema ? (spec?.endpoint ?? cfg.kind) : cfg.kind;
    assertEndpoint(spec, kind, cfg.model);

    const refs = cfg.refs ?? [];
    // Validate with the raw refs first so a bad flag never costs an upload.
    buildModelInput(spec, cfg.requests(refs));
    const refUrls = refs.length > 0 ? await resolveMediaRefs(client, refs, logger) : [];
    return { kind, body: buildModelInput(spec, cfg.requests(refUrls)) };
  });
  logger.debug(`Request fields: ${Object.keys(body).join(", ")}`);

  return executePrediction({
    client,
    logger,
    kind,
    model: cfg.model,
    body,
    opts: cfg.opts,
    hint: cfg.hint,
    defaultWaitTimeoutMs: cfg.defaultWaitTimeoutMs,
    pollIntervalMs: cfg.pollIntervalMs,
  });
}
