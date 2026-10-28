/**
 * Legacy account helpers:
 * - `topview upload <file>`: upload a local file and print its fileId, for
 *   reuse in any `--... <path|fileId>` flag.
 * - `topview credits`: remaining legacy API credits and their expiry. This is
 *   balance information only, not spend. API Platform (USD) balances are not
 *   exposed by any documented endpoint; see the platform console.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { TOPVIEW_PLATFORM_DASHBOARD_LINK } from "../models.js";
import { createTopviewClient } from "../node-client.js";
import { isLocalFile, resolveLegacyFile } from "../node-inputs.js";

export function registerAccountCommands(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local image, audio or video file to TopView and print its fileId")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      if (!isLocalFile(file)) throw new ValidationError(`File not found: ${file}`);
      const client = createTopviewClient();
      console.log(await resolveLegacyFile(file, "<file>", client, logger));
    });

  parent
    .command("credits")
    .description("Remaining legacy API credits (TopView API Platform balance: see its console)")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createTopviewClient();
      const detail = await client.getCredits();
      if (opts.json) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      console.log(`Remaining credits: ${detail.remainCredit ?? "unknown"}`);
      if (detail.expiredTime !== undefined) console.log(`Expires: ${detail.expiredTime}`);
      console.error(
        `  API Platform (USD) balance is separate; see ${TOPVIEW_PLATFORM_DASHBOARD_LINK}`,
      );
    });
}
