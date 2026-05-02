/**
 * multix leonardo status <generationId> — fetch a generation's status and image URLs.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import type { GetGenerationResponse } from "../types.js";

export function registerLeonardoStatusCommand(parent: Command): void {
  parent
    .command("status <generationId>")
    .description("Get a Leonardo generation's status and image URLs")
    .option("-v, --verbose", "Verbose logging")
    .action(async (generationId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createLeonardoClient();
      const res = await client.get<GetGenerationResponse>(
        `/generations/${generationId}`,
        undefined,
        logger,
      );
      const gen = res.generations_by_pk;
      if (!gen) {
        logger.warn("No generation found.");
        return;
      }
      console.error(`status: ${gen.status}`);
      for (const img of gen.generated_images ?? []) {
        console.log(img.url);
      }
    });
}
