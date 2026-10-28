/**
 * multix sume models — the live Sume catalogue (public, keyless), cached
 * like `multix models --live`: fresh, cached, stale (a failed read served
 * from an older copy) or unavailable. Needs no SUME_API_KEY.
 */

import type { Command } from "commander";
import { untrackedFetch } from "../../../agent/fetch-telemetry.js";
import { discoverSumeCatalog } from "../../../commands/agent/model-discovery-cache.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { type SumeCatalogModel, formatPriceRange, ownRoutes } from "../catalog.js";

const KINDS = ["image", "video", "lipsync", "captions"] as const;
const MAX_LIST = 6;

interface ModelsOpts {
  kind?: string;
  refresh?: boolean;
  json?: boolean;
}

/** One line of capabilities: flags that are true, value lists and ranges. */
export function summarizeCapabilities(cap: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(cap)) {
    if (key === "routes") continue;
    if (value === true) parts.push(key);
    else if (typeof value === "number") parts.push(`${key} ${value}`);
    else if (Array.isArray(value) && value.length > 0) {
      const items = value.slice(0, MAX_LIST).map(String).join("|");
      parts.push(`${key} ${items}${value.length > MAX_LIST ? "|…" : ""}`);
    } else if (value && typeof value === "object") {
      const { min, max } = value as { min?: unknown; max?: unknown };
      if (typeof min === "number" && typeof max === "number") parts.push(`${key} ${min}-${max}`);
    }
  }
  return parts.join(", ");
}

function modelView(m: SumeCatalogModel) {
  const routes = ownRoutes(m);
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    kind: m.kind,
    modes: m.modes,
    capabilities: m.capabilities,
    ...(m.pricing
      ? {
          pricing: {
            unit: m.pricing.unit ?? null,
            from_usd: m.pricing.from_usd ?? null,
            to_usd: m.pricing.to_usd ?? null,
          },
        }
      : {}),
    ...(m.constraints.length ? { constraints: m.constraints } : {}),
    ...(m.request_fields ? { request_fields: m.request_fields } : {}),
    // Sume Remix models have their own endpoints, which `multix sume` does not call.
    ...(routes.length ? { routes, runnable: false } : {}),
  };
}

export function registerSumeModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List Sume's live model catalogue: ids, modes, capabilities and USD prices")
    .option("--kind <kind>", `Only one kind: ${KINDS.join(", ")}`)
    .option("--refresh", "Read the catalogue again instead of using the cached copy")
    .option("--json", "Print JSON")
    .action(async (opts: ModelsOpts) => {
      if (opts.kind !== undefined && !(KINDS as readonly string[]).includes(opts.kind)) {
        throw new ValidationError(`--kind must be one of ${KINDS.join(", ")}`);
      }
      const result = await discoverSumeCatalog({
        refresh: opts.refresh ?? false,
        fetchFn: untrackedFetch,
      });
      if (!result.catalog) {
        throw new ProviderError(
          `Sume catalogue unavailable: ${result.error ?? "no response"}. Try again later`,
          "sume",
        );
      }
      const models = result.catalog.models.filter((m) => !opts.kind || m.kind === opts.kind);
      const source = {
        state: result.state,
        url: result.url,
        fetched_at: result.fetched_at,
        ...(result.error ? { error: result.error } : {}),
      };
      if (opts.json) {
        console.log(JSON.stringify({ source, models: models.map(modelView) }, null, 2));
        return;
      }
      for (const m of models) {
        console.log(`${m.id}${m.name ? `  (${m.name})` : ""}`);
        console.log(`  kind: ${m.kind}   modes: ${m.modes.join(", ") || "-"}`);
        const caps = summarizeCapabilities(m.capabilities);
        if (caps) console.log(`  capabilities: ${caps}`);
        const price = formatPriceRange(m);
        if (price) console.log(`  price: ${price}`);
        const routes = ownRoutes(m);
        if (routes.length)
          console.log(`  own endpoint (not run by multix sume): ${routes.join(", ")}`);
      }
      const stale = result.error ? ` (stale: ${result.error})` : "";
      console.log(
        `\n${models.length} model(s); source ${source.url}, fetched ${source.fetched_at}, ${source.state}${stale}`,
      );
    });
}
