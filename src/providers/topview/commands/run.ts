/**
 * `topview run <route> --input <json|@file>` (API Platform): submit a
 * prediction on a verified route (`topview models`). The route and the
 * body's top-level shape are checked before any request. Every submission
 * carries an Idempotency-Key, generated before the request and reused on
 * its own retries; Ctrl-C or an ambiguous failure during the submit prints
 * it, and `--idempotency-key` retries that submission without paying twice. Async by default; --wait polls and downloads. The input body is
 * never logged.
 */

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { exitOnInterrupt } from "../../atlascloud/commands/prediction-runner.js";
import { assertBodyFamily, assertIdempotencyKey, assertPlatformRoute } from "../models.js";
import { createTopviewPlatformClient } from "../node-client.js";
import { platformOrphanHint } from "../platform-client.js";
import {
  type WaitFlagOptions,
  addWaitOptions,
  assertWaitFlags,
  completePrediction,
  logPlatformCost,
  parsePositiveInt,
  printPredictionHandle,
} from "./task-flow.js";

interface RunOpts extends WaitFlagOptions {
  input?: string;
  idempotencyKey?: string;
}

export function registerTopviewRunCommand(parent: Command): void {
  const cmd = parent
    .command("run <route>")
    .description(
      "API Platform: run a prediction on a verified route (see `topview models`); prints an id unless --wait",
    )
    .option("--input <json|@file>", "Request body as JSON, or @path to a JSON file (required)")
    .option(
      "--idempotency-key <key>",
      "Reuse the key of an earlier submission whose outcome is unknown (same body)",
    );
  addWaitOptions(cmd, 1_800_000).action(async (route: string, opts: RunOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    assertWaitFlags(opts, "multix topview prediction <id> --wait --download");
    const waitTimeoutMs = parsePositiveInt(opts.waitTimeout, "--wait-timeout");
    const spec = assertPlatformRoute(route);
    if (opts.input === undefined) {
      throw new ValidationError("--input <json|@file> is required");
    }
    const body = assertBodyFamily(spec, parseJsonInput(opts.input));
    // Generated here, before the request, so an interrupted submit can still name it.
    const key =
      opts.idempotencyKey !== undefined ? assertIdempotencyKey(opts.idempotencyKey) : randomUUID();
    const client = createTopviewPlatformClient();
    logger.info(`TopView API Platform: ${spec.route}`);
    const hint = platformOrphanHint(spec.route, key);
    const { prediction, idempotencyKey } = await exitOnInterrupt(
      () => client.submit(spec.route, body, { idempotencyKey: key }),
      {
        message: `Stopped while submitting to TopView. ${hint}`,
        outcome: { hint, retryable: false },
      },
    );
    logger.success(`Created TopView prediction ${prediction.id} (${prediction.status})`);
    logPlatformCost(logger, prediction);
    if (!opts.wait) {
      printPredictionHandle(prediction, idempotencyKey);
      return;
    }
    await completePrediction(client, prediction.id, {
      waitTimeoutMs,
      logger,
      download: opts.download !== false,
      rawUrls: opts.download === false,
      output: opts.output,
    });
  });
}
