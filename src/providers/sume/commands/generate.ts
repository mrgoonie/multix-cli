/**
 * The submit flow shared by `multix sume image` and `multix sume video`:
 * validate flags and the request against the model's catalogue entry,
 * upload local media, submit once with an idempotency key (retries reuse
 * it), then print the job handle or wait and download.
 */

import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { assertIdempotencyKey, newIdempotencyKey } from "../models.js";
import { createSumeClient } from "../node-client.js";
import { resolveMediaInputs } from "../node-inputs.js";
import { type SumeRouter, buildSumeBody, mediaInputs } from "../request.js";
import type { SumeRequestBody } from "../types.js";
import { checkAgainstCatalog } from "./catalog-check.js";
import {
  type WaitFlagOptions,
  completeJob,
  logSubmitted,
  parsePositiveInt,
  printJobHandle,
  retryWithKeyCommand,
} from "./job-flow.js";

export interface GenerateOpts extends WaitFlagOptions {
  model?: string;
  wait?: boolean;
  idempotencyKey?: string;
  input?: string;
  [option: string]: unknown;
}

export interface GenerateRun {
  router: SumeRouter;
  prompt: string | undefined;
  opts: GenerateOpts;
  /** Post-process saved files (image WebP conversion). */
  finalize?: (files: string[], body: SumeRequestBody) => string[];
}

export async function runGenerate({ router, prompt, opts, finalize }: GenerateRun): Promise<void> {
  const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
  if (!opts.wait && (opts.output !== undefined || opts.download !== undefined)) {
    throw new ValidationError(
      "--output and --download/--no-download need --wait (or use `multix sume status <jobId> --wait --download` later)",
    );
  }
  const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
  const idempotencyKey =
    opts.idempotencyKey !== undefined
      ? assertIdempotencyKey(opts.idempotencyKey)
      : newIdempotencyKey();

  // Validate every flag before anything is uploaded or billed.
  const draft = buildSumeBody(router, opts, { prompt });
  if (router === "image" && typeof draft.prompt !== "string") {
    throw new ValidationError("A prompt is required: multix sume image <prompt> -m <model>");
  }
  await checkAgainstCatalog(router, draft, logger);

  const client = createSumeClient();
  const media = await resolveMediaInputs(mediaInputs(router, opts), () => client, logger);
  const body = buildSumeBody(router, opts, { prompt, media });

  logger.info(`Sume ${router}: ${body.model}`);
  logger.debug(`Idempotency-Key: ${idempotencyKey}`);
  const submitOpts = {
    idempotencyKey,
    retryCommand: (key: string) =>
      retryWithKeyCommand(`multix sume ${router} <same arguments>`, key),
    onRetry: (attempt: number, delayMs: number, reason: string) =>
      logger.warn(
        `Sume submit failed (${reason}); retrying in ${Math.ceil(delayMs / 1000)}s with the same idempotency key (retry ${attempt})`,
      ),
  };
  const submitted =
    router === "image"
      ? await client.generateImage(body, submitOpts)
      : await client.generateVideo(body, submitOpts);
  logSubmitted(logger, submitted);

  if (!opts.wait) {
    printJobHandle(submitted.job.id);
    return;
  }
  await completeJob(client, submitted.job.id, {
    waitTimeoutMs,
    logger,
    download: opts.download !== false,
    rawUrls: opts.download === false,
    output: opts.output,
    finalize: finalize ? (files) => finalize(files, body) : undefined,
  });
}
