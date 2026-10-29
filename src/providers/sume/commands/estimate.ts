/**
 * multix sume estimate -m <id> [flags] — Sume's own price quote for a
 * request (POST /v1/open/estimate; not billed). Prints Sume's `data` as JSON,
 * labelled as Sume's quote. It does not feed --max-cost: the pre-flight check
 * prices from the cached catalog (`multix sume image|video --estimate`).
 * Local files are not uploaded for a quote; pass https URLs to include them.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { routerFor } from "../models.js";
import { requestCatalog } from "../node-catalog.js";
import { createSumeClient } from "../node-client.js";
import { checkRemoteInput } from "../node-inputs.js";
import { flagsFromOptions, planSumeRequest } from "../request-plan.js";
import { collect } from "./job-flow.js";

interface EstimateOpts {
  model?: string;
  verbose?: boolean;
  [flag: string]: unknown;
}

export function registerSumeEstimateCommand(parent: Command): void {
  parent
    .command("estimate [prompt]")
    .description("Ask Sume for its price quote of a request (not billed)")
    .requiredOption("-m, --model <id>", "Model id from `multix sume models`")
    .option("--image <url>", "Input or first-frame image URL (repeatable)", collect)
    .option("--end-image <url>", "End-frame image URL")
    .option("--reference-image <url>", "Reference image URL (repeatable)", collect)
    .option("--video <url>", "Source video URL")
    .option("--audio <url>", "Audio URL for lip-sync models")
    .option("--duration <seconds>", "Duration in whole seconds")
    .option("--resolution <resolution>", "Resolution the model lists")
    .option("--aspect-ratio <ratio>", "Aspect ratio the model lists")
    .option("--image-size <size>", "Image size (image models)")
    .option("--quality <quality>", "Quality the model lists (image models)")
    .option("--num-images <n>", "Number of images (image models)")
    .option("--output-format <format>", "Output format (image models)")
    .option("--generate-audio", "Make a soundtrack (video models with audio)")
    .option("--no-generate-audio", "Make no soundtrack (video models with audio)")
    .option("--param <key=value>", "Another request field the model lists (repeatable)", collect)
    .option("-v, --verbose", "Verbose logging")
    .action(async (prompt: string | undefined, opts: EstimateOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const client = createSumeClient();
      const loaded = await requestCatalog(client, run.dryRun);
      const id = (opts.model ?? "").trim();
      const model = loaded.catalog.models.find((m) => m.id === id);
      if (!model) {
        throw new ValidationError(
          `Sume's catalog does not list model ${id}. List the models with: multix sume models`,
        );
      }
      const plan = planSumeRequest({
        command: routerFor(model.kind),
        model,
        prompt,
        flags: flagsFromOptions(opts),
        checkPrompt: prompt !== undefined,
      });
      const { model: _model, ...input } = plan.body;
      for (const item of plan.media) {
        // A quote needs no upload: only URLs are passed on.
        const urls = item.values.map((v) => {
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
            throw new ValidationError(
              `${item.flag}: sume estimate takes https URLs, not local files`,
            );
          }
          return checkRemoteInput(v, item.flag);
        });
        input[item.field] = item.list ? urls : urls[0];
      }
      const quote = await client.estimate(model.id, input);
      logger.info(`Sume's quote for ${model.id} (from Sume, not billed; not used by --max-cost):`);
      console.log(JSON.stringify({ source: "sume", model: model.id, quote }, null, 2));
    });
}
