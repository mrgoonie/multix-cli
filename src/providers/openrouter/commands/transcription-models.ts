/**
 * multix openrouter transcription-models — list OpenRouter's speech-to-text
 * models live (GET /models?output_modalities=transcription).
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { findTranscriptionModel, listTranscriptionModels } from "../transcription-client.js";

export function registerOpenRouterTranscriptionModelsCommand(parent: Command): void {
  parent
    .command("transcription-models")
    .description("List OpenRouter speech-to-text models and their prices (live catalog)")
    .option("--model <id>", "Show one model")
    .action(async (opts: { model?: string }) => {
      const models = await listTranscriptionModels();
      const shown = opts.model ? [findTranscriptionModel(models, opts.model)] : models;
      if (shown[0] === undefined) {
        throw new ValidationError(
          `Model ${opts.model} is not an OpenRouter transcription model (model not found). Run: multix openrouter transcription-models`,
        );
      }
      if (run.json) {
        console.log(JSON.stringify(opts.model ? shown[0] : models));
        return;
      }
      for (const m of shown) {
        if (m) console.log(`${m.id}\t${m.name ?? ""}\t${formatPrice(m.pricing)}`);
      }
    });
}

/** OpenRouter prices audio per second for duration-priced models and per token for token-priced ones. */
function formatPrice(pricing: { prompt?: string; completion?: string }): string {
  const input = Number(pricing.prompt);
  const output = Number(pricing.completion);
  if (!Number.isFinite(input)) return "price not listed";
  if (input === 0 && !(output > 0)) return "free";
  const parts = [`input $${pricing.prompt}/unit`];
  if (Number.isFinite(output) && output > 0) parts.push(`output $${pricing.completion}/token`);
  return parts.join(", ");
}
