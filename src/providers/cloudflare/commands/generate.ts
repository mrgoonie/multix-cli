import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import { createLogger } from "../../../core/logger.js";
import { runCloudflareJson } from "../client.js";
import { saveBase64Image } from "../media-output.js";
import { getCloudflareModel, validateImageSteps } from "../models.js";

interface ImageResult {
  image?: string;
}

export function registerCloudflareGenerateCommand(parent: Command): void {
  parent
    .command("generate")
    .description("Generate an image with Cloudflare Workers AI FLUX.1 Schnell")
    .requiredOption("--prompt <text>", "Image prompt")
    .option("--model <id>", "Cloudflare image model")
    .option("--steps <n>", "Inference steps (1-8)", "4")
    .option("--seed <n>", "Optional non-negative integer seed")
    .option("--output <path>", "Save image at this path")
    .addOption(imageFormatOption())
    .addOption(noWebpOption())
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        model?: string;
        steps: string;
        seed?: string;
        output?: string;
        imageFormat?: string;
        webp?: boolean;
        verbose?: boolean;
      }) => {
        if (!opts.prompt.trim()) throw new ValidationError("--prompt must not be empty");
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = getCloudflareModel("image", opts.model);
        const steps = validateImageSteps(opts.steps);
        const input: Record<string, unknown> = { prompt: opts.prompt, steps };

        if (opts.seed !== undefined) {
          if (!/^\d+$/.test(opts.seed)) {
            throw new ValidationError("--seed must be a non-negative integer");
          }
          const seed = Number.parseInt(opts.seed, 10);
          if (!Number.isInteger(seed) || seed < 0) {
            throw new ValidationError("--seed must be a non-negative integer");
          }
          input.seed = seed;
        }

        logger.debug(`Cloudflare image model=${model} steps=${steps}`);
        const result = await runCloudflareJson<ImageResult>(model, input);
        if (typeof result.image !== "string") {
          throw new ProviderError("Cloudflare returned no image result", "Cloudflare");
        }
        const saved = saveBase64Image(result.image, opts.output);
        logger.success(`Saved ${saved}`);
        const [destination] = finalizeGeneratedImages([saved], { ...opts, logger });
        console.log(destination);
      },
    );
}
