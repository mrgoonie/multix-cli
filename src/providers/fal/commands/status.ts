/**
 * multix fal status [model] <requestId> — get a submitted job's queue status.
 * The model may be left out when `fal submit`/`fal run` saved a receipt.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createFalClient, statusPath } from "../client.js";
import { updateReceiptStatus } from "../job-receipts.js";
import type { FalStatusResponse } from "../types.js";
import { resolveJobRef } from "./job-ref.js";

export function registerFalStatusCommand(parent: Command): void {
  parent
    .command("status <modelOrRequestId> [requestId]")
    .description("Get a fal.ai request's queue status (model optional when a receipt was saved)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (first: string, second: string | undefined, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const { model, requestId } = resolveJobRef(first, second);
      const client = createFalClient();
      const res = await client.get<FalStatusResponse>(statusPath(model, requestId), logger);
      if (typeof res?.status === "string") updateReceiptStatus(requestId, res.status);
      console.log(JSON.stringify(res, null, 2));
    });
}
