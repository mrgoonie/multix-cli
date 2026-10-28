/**
 * Pre-flight price of a `sume image` / `sume video` run for `--estimate` and
 * `--max-cost`. With SUME_API_KEY the exact input is priced by Sume's
 * non-billable POST /v1/open/estimate (a proven cap); without a key, or when
 * that call fails, the catalog list price is used (an estimate, not a cap).
 * Both carry their source and timestamp. Local media files are not uploaded
 * to price a run.
 */

import { untrackedFetch } from "../../../agent/fetch-telemetry.js";
import type { CostEstimate } from "../../../budget/cost-estimate.js";
import { MultixError } from "../../../core/errors.js";
import { SumeClient } from "../client.js";
import { SUME_PATHS } from "../models.js";
import { estimateFromCatalog, estimateFromQuote, unknownSumeEstimate } from "../pricing.js";
import { mapMediaRefs, mediaRefs } from "../request.js";
import type { SumeRouter } from "../types.js";
import { isRemoteRef, optionalSumeKey, sumeBaseUrl } from "./env.js";
import { type SumeImageCliOpts, type SumeVideoCliOpts, planRequest } from "./request-options.js";

export async function estimateSumeRun(
  router: SumeRouter,
  prompt: string | undefined,
  opts: SumeImageCliOpts | SumeVideoCliOpts,
  fetch: typeof globalThis.fetch = untrackedFetch(),
): Promise<CostEstimate> {
  const at = new Date();
  // Input errors (unknown model, unsupported flag) stop the run here, before anything is sent.
  const { catalog, model, body } = await planRequest(router, prompt, opts, fetch);
  const notes: string[] = [];
  if (mediaRefs(body).some((ref) => !isRemoteRef(ref))) {
    notes.push(
      "Local input files were not uploaded to price the run; the price does not depend on their bytes.",
    );
  }
  if (catalog.source.state === "stale") {
    notes.push(
      `Catalog copy from ${catalog.source.fetched_at} (live read failed: ${catalog.source.error}).`,
    );
  }
  const input = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "model"));
  const apiKey = optionalSumeKey();
  if (apiKey) {
    const baseUrl = sumeBaseUrl();
    try {
      const client = new SumeClient({ apiKey, baseUrl, fetch, timeoutMs: 15_000 });
      const remoteOnly = await mapMediaRefs(input, async (ref) =>
        isRemoteRef(ref) ? ref : undefined,
      );
      const quote = await client.estimate(model.id, remoteOnly);
      return estimateFromQuote(model.id, quote, {
        source: `${baseUrl}${SUME_PATHS.estimate}`,
        at,
        notes,
      });
    } catch (error) {
      const reason = error instanceof MultixError ? error.message : String(error);
      notes.push(
        `Sume's estimate endpoint failed (${reason.slice(0, 200)}); using the catalog list price.`,
      );
    }
  }
  if (!catalog.source.url || !catalog.source.fetched_at) {
    return unknownSumeEstimate(model.id, "no_price", "The Sume catalog is unavailable.", at);
  }
  return estimateFromCatalog(model, body, {
    source: catalog.source.url,
    fetchedAt: catalog.source.fetched_at,
    at,
    notes,
  });
}
