/**
 * multix openrouter generation <id> — the resolved model, provider and cost
 * of one OpenRouter generation (GET /generation?id=), e.g. a `tts` run whose
 * cost was not reported in time.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { HttpError, MultixError, ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { requireOpenRouterKey } from "../client.js";
import { buildOpenRouterHeaders } from "../payload.js";
import { type GenerationStats, getGeneration } from "../speech-client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll /generation until it has the stats or `waitMs` passed; undefined when it never answered. */
export async function waitForGeneration(
  id: string,
  headers: Record<string, string>,
  waitMs: number,
  logger: Logger,
): Promise<GenerationStats | undefined> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const stats = await getGeneration({ id, headers });
      if (stats) return stats;
    } catch (err) {
      // The output is already saved; a failed lookup only leaves the cost unknown.
      logger.debug(`generation lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!(err instanceof HttpError) || err.status !== 0) return undefined;
    }
    const delay = Math.min(1000 * 2 ** attempt, 4000);
    if (Date.now() + delay > deadline) return undefined;
    await sleep(delay);
  }
}

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
