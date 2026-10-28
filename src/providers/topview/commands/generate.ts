/**
 * multix topview generate <owner/model/mode> --input <json> — one prediction on
 * the TopView API Platform (separate USD balance, TOPVIEW_API_PLATFORM_KEY).
 * Only routes the Platform docs list are accepted (`topview models`); the
 * body is the model's native JSON and the Platform validates it.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { PLATFORM_ROUTES, findPlatformRoute, routeId } from "../models.js";
import { assertValidIdempotencyKey } from "../platform-client.js";
import { createPlatformClientFromEnv, createTopviewLogger } from "./env.js";
import { parseJsonObject } from "./json-input.js";
import { type TaskCliOpts, addTaskOptions, runPlatformTask } from "./task-runner.js";

const WAIT_MS = 1_800_000;

interface GenerateFlags extends TaskCliOpts {
  input: string;
  idempotencyKey?: string;
}

export function registerGenerateCommand(parent: Command): void {
  addTaskOptions(
    parent
      .command("generate <route>")
      .description(
        "API Platform prediction, e.g. bytedance/seedance-2.0-mini/text-to-video (USD balance)",
      )
      .requiredOption(
        "--input <json>",
        "The model's native request body: JSON object or @file.json",
      )
      .option(
        "--idempotency-key <key>",
        "Reuse the key of a submit whose outcome was unknown to get that task back (default: new random key)",
      ),
    WAIT_MS,
  ).action(async (route: string, opts: GenerateFlags) => {
    const found = findPlatformRoute(route);
    if (!found) {
      throw new ValidationError(
        `Unknown or unverified TopView Platform route "${route}". Verified routes: ${PLATFORM_ROUTES.map(routeId).join(", ")}`,
      );
    }
    const body = parseJsonObject(opts.input, "--input");
    const idempotencyKey = opts.idempotencyKey?.trim() || crypto.randomUUID();
    assertValidIdempotencyKey(idempotencyKey);
    const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: opts.async });
    await runPlatformTask({
      client: createPlatformClientFromEnv(),
      logger,
      route: found,
      body,
      idempotencyKey,
      opts,
      defaultWaitMs: WAIT_MS,
    });
  });
}
