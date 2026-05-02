/**
 * multix leonardo models — list Leonardo platform image models.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import type { ListPlatformModelsResponse } from "../types.js";

export function registerLeonardoModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List Leonardo platform image models")
    .option("--limit <n>", "Limit number of results")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: { limit?: string; verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createLeonardoClient();
      const res = await client.get<ListPlatformModelsResponse>(
        "/platformModels",
        undefined,
        logger,
      );
      const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
      const models = limit ? res.custom_models.slice(0, limit) : res.custom_models;
      for (const m of models) {
        console.log(`${m.id}\t${m.name}`);
      }
      logger.debug(`${models.length} model(s)`);
    });
}
