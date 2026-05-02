/**
 * multix leonardo me — show authenticated user info and remaining credits.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import type { UserInfo } from "../types.js";

export function registerLeonardoMeCommand(parent: Command): void {
  parent
    .command("me")
    .description("Show authenticated Leonardo user info and remaining API credits")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createLeonardoClient();
      const info = await client.get<UserInfo>("/me", undefined, logger);
      const u = info.user_details?.[0];
      if (!u) {
        logger.warn("No user info returned.");
        return;
      }
      logger.success(`User: ${u.user.username} (${u.user.id})`);
      console.log(`Tokens: ${u.subscriptionTokens} | API credit: ${u.apiCredit ?? "n/a"}`);
    });
}
