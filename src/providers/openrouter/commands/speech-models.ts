/**
 * multix openrouter speech-models — list OpenRouter's text-to-speech models
 * live (GET /models?output_modalities=speech), or one model's voices.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { findSpeechModel, listSpeechModels } from "../speech-client.js";

export function registerOpenRouterSpeechModelsCommand(parent: Command): void {
  parent
    .command("speech-models")
    .description("List OpenRouter text-to-speech models and their voices (live catalog)")
    .option("--model <id>", "Show one model with all of its voices")
    .action(async (opts: { model?: string }) => {
      const models = await listSpeechModels();
      if (opts.model) {
        const entry = findSpeechModel(models, opts.model);
        if (!entry) {
          throw new ValidationError(
            `Model ${opts.model} is not an OpenRouter speech model (model not found). Run: multix openrouter speech-models`,
          );
        }
        if (run.json) {
          console.log(JSON.stringify(entry));
          return;
        }
        console.log(`${entry.id}\t${entry.name ?? ""}`);
        console.log(`  price: ${formatPrice(entry.pricing)}`);
        console.log(
          entry.voices.length
            ? `  voices (${entry.voices.length}): ${entry.voices.join(", ")}`
            : "  voices: none listed (the provider's default or --voice of your own)",
        );
        return;
      }
      if (run.json) {
        console.log(JSON.stringify(models));
        return;
      }
      for (const m of models) {
        const voices = m.voices.length ? `${m.voices.length} voices` : "no listed voices";
        console.log(`${m.id}\t${m.name ?? ""}\t${voices}\t${formatPrice(m.pricing)}`);
      }
    });
}

function formatPrice(pricing: { prompt?: string; completion?: string }): string {
  const perChar = Number(pricing.prompt);
  const perSecond = Number(pricing.completion);
  if (Number.isFinite(perSecond) && perSecond > 0) return `$${perSecond}/s of audio`;
  if (Number.isFinite(perChar) && perChar > 0)
    return `$${Math.round(perChar * 1e8) / 100}/1M chars`;
  return pricing.prompt === "0" ? "free" : "price not listed";
}
