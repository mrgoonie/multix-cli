/**
 * `topview credit` (Legacy API, GET /user/credit/detail, free): remaining
 * topview.ai plan credits and recent API tasks. `remainCredit` is a balance,
 * never spend. The API Platform has a separate USD balance shown only in its
 * console.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { TOPVIEW_PLATFORM_CONSOLE_LINK } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";

export function registerTopviewCreditCommand(parent: Command): void {
  parent
    .command("credit")
    .description("Legacy API: remaining plan credits and recent API tasks (free)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const client = createTopviewLegacyClient();
      const detail = await client.creditDetail();
      console.log(JSON.stringify(detail, null, 2));
      logger.info(
        `Legacy API credits are shared with your topview.ai plan. The API Platform (TOPVIEW_PLATFORM_API_KEY) has a separate USD balance: ${TOPVIEW_PLATFORM_CONSOLE_LINK}`,
      );
    });
}
