/**
 * multix openrouter video-models — list available OpenRouter video models.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { listVideoModels } from "../video-client.js";

export function registerOpenRouterVideoModelsCommand(parent: Command): void {
  parent
    .command("video-models")
    .description("List available OpenRouter video models")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const res = await listVideoModels();
      const list = res.data ?? res.models ?? [];
      for (const m of list) {
        console.log(`${m.id}\t${m.name ?? ""}`);
      }
      logger.debug(`${list.length} model(s)`);
    });
}
