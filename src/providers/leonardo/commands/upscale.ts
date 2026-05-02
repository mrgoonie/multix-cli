/**
 * multix leonardo upscale <imageId> — Universal Upscaler async submit.
 * multix leonardo variation <id>    — fetch variation/upscale result by id.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createLeonardoClient } from "../client.js";
import type { UpscaleResponse, UpscaleVariationStatus } from "../types.js";

export function registerLeonardoUpscaleCommands(parent: Command): void {
  parent
    .command("upscale <generatedImageId>")
    .description("Upscale a generated image via Leonardo Universal Upscaler")
    .option("--style <style>", "Upscaler style (GENERAL, CINEMATIC, ...)", "GENERAL")
    .option("--strength <n>", "Creativity strength (0-1)", "0.35")
    .option("--multiplier <n>", "Upscale multiplier (1-2)", "1.5")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        generatedImageId: string,
        opts: { style: string; strength: string; multiplier: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createLeonardoClient();

        logger.info(`Submitting upscale for image ${generatedImageId}`);
        const res = await client.post<UpscaleResponse>(
          "/variations/universal-upscaler",
          {
            generatedImageId,
            upscalerStyle: opts.style,
            creativityStrength: Number.parseFloat(opts.strength),
            upscaleMultiplier: Number.parseFloat(opts.multiplier),
          },
          logger,
        );
        const variationId = res.universalUpscaler.id;
        logger.success(`variationId: ${variationId}`);
        console.log(variationId);
        console.error(`Use: multix leonardo variation ${variationId}`);
      },
    );

  parent
    .command("variation <variationId>")
    .description("Fetch a Leonardo variation/upscale result by ID")
    .option("-v, --verbose", "Verbose logging")
    .action(async (variationId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const client = createLeonardoClient();
      const res = await client.get<UpscaleVariationStatus>(
        `/variations/${variationId}`,
        undefined,
        logger,
      );
      for (const v of res.generated_image_variation_generic ?? []) {
        console.log(`${v.status}\t${v.url ?? ""}`);
      }
    });
}
