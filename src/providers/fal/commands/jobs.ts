/**
 * multix fal jobs — list the receipts saved by `fal submit` and `fal run`,
 * newest first, as JSON (last known status; refresh with `fal status`).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { falJobsDir, listReceipts } from "../job-receipts.js";

export function registerFalJobsCommand(parent: Command): void {
  parent
    .command("jobs")
    .description("List saved fal.ai job receipts (newest first)")
    .option("--limit <n>", "How many receipts to show", "20")
    .action((opts: { limit: string }) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new ValidationError(`Invalid --limit: ${opts.limit}`);
      }
      console.log(JSON.stringify({ dir: falJobsDir(), jobs: listReceipts(limit) }, null, 2));
    });
}
