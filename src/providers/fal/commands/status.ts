/**
 * multix fal status <model> <requestId> — poll a submitted job's queue status.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createFalClient, statusPath } from "../client.js";
import type { FalStatusResponse } from "../types.js";

export function registerFalStatusCommand(parent: Command): void {
  parent
    .command("status <model> <requestId>")
    .description("Get a fal.ai request's queue status")
    .option("-v, --verbose", "Verbose logging")
    .action(async (model: string, requestId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createFalClient();
      const res = await client.get<FalStatusResponse>(statusPath(model, requestId), logger);
      console.log(JSON.stringify(res, null, 2));
    });
}
