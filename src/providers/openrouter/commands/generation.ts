/**
 * multix openrouter generation <id> — the resolved model, provider and cost
 * of one OpenRouter generation (GET /generation?id=), e.g. a `tts` run whose
 * cost was not reported in time.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { MultixError, ValidationError } from "../../../core/errors.js";
import { requireOpenRouterKey } from "../client.js";
import { buildOpenRouterHeaders } from "../payload.js";
import { getGeneration } from "../speech-client.js";

export function registerOpenRouterGenerationCommand(parent: Command): void {
  parent
    .command("generation")
    .description("Show the model, provider and cost OpenRouter recorded for a generation id")
    .argument("<id>", "Generation id (X-Generation-Id, e.g. from `openrouter tts`)")
    .action(async (id: string) => {
      if (!/^[\w.:-]{1,128}$/.test(id)) throw new ValidationError(`Invalid generation id: ${id}`);
      const stats = await getGeneration({
        id,
        headers: buildOpenRouterHeaders(requireOpenRouterKey()),
      });
      if (!stats) {
        throw new MultixError(
          `Generation ${id} not found (yet): OpenRouter records a generation about 10 s after its response, so retry shortly if the id is right`,
          "NOT_FOUND",
        );
      }
      if (run.json) {
        console.log(
          JSON.stringify({
            generation_id: stats.id,
            model_resolved: stats.model ?? null,
            provider: stats.providerName ?? null,
            cost_usd: stats.totalCost ?? null,
            cost_source: "openrouter-generation",
            upstream_cost_usd: stats.upstreamCost ?? null,
            is_byok: stats.isByok ?? null,
            tokens_prompt: stats.tokensPrompt ?? null,
            tokens_completion: stats.tokensCompletion ?? null,
            latency_ms: stats.latencyMs ?? null,
          }),
        );
        return;
      }
      console.log(`id:       ${stats.id}`);
      console.log(`model:    ${stats.model ?? "unknown"}`);
      console.log(`provider: ${stats.providerName ?? "unknown"}`);
      console.log(`cost:     ${stats.totalCost !== undefined ? `$${stats.totalCost}` : "unknown"}`);
      if (stats.isByok) console.log(`upstream: $${stats.upstreamCost ?? "unknown"} (BYOK)`);
    });
}
