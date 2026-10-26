/**
 * multix openrouter speech-models — list OpenRouter's text-to-speech models
 * live (GET /models?output_modalities=speech), or one model's voices.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { type SpeechModel, findSpeechModel, listSpeechModels } from "../speech-client.js";

function toJson(m: SpeechModel) {
  return {
    id: m.id,
    canonical_slug: m.canonicalSlug ?? null,
    name: m.name ?? null,
    voices: m.voices,
    pricing: { prompt: m.pricing.prompt ?? null, completion: m.pricing.completion ?? null },
    price: formatPrice(m.pricing),
  };
}

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
          console.log(JSON.stringify(toJson(entry)));
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
        console.log(JSON.stringify(models.map(toJson)));
        return;
      }
      for (const m of models) {
        const voices = m.voices.length ? `${m.voices.length} voices` : "no listed voices";
        console.log(`${m.id}\t${m.name ?? ""}\t${voices}\t${formatPrice(m.pricing)}`);
      }
    });
}

/**
 * OpenRouter speech pricing comes in three shapes: `prompt` only = USD per
 * input character, `completion` only = USD per output second (Seed Audio),
 * both = USD per input and output token (Gemini TTS).
 */
function formatPrice(pricing: { prompt?: string; completion?: string }): string {
  const perIn = Number(pricing.prompt);
  const perOut = Number(pricing.completion);
  const hasIn = Number.isFinite(perIn) && perIn > 0;
  const hasOut = Number.isFinite(perOut) && perOut > 0;
  const perMillion = (n: number) => Math.round(n * 1e8) / 100;
  if (hasIn && hasOut) {
    return `$${perMillion(perIn)}/1M input tokens + $${perMillion(perOut)}/1M audio tokens`;
  }
  if (hasOut) return `$${perOut}/s of audio`;
  if (hasIn) return `$${perMillion(perIn)}/1M chars`;
  return pricing.prompt === "0" ? "free" : "price not listed";
}
