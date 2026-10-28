/**
 * `topview models` (API Platform): the verified prediction routes multix
 * accepts for `topview run`, joined with the public model and price catalog
 * (GET /platform/v1/models, no key needed). Routes are hand-maintained, each
 * with its source URL and verified_at date; prices are shown exactly as the
 * provider reports them (USD strings) with the time they were fetched. The
 * catalog is cached on disk (MULTIX_MODELS_TTL); --refresh refetches.
 * A catalog failure still lists the routes, without prices.
 */

import type { Command } from "commander";
import { PLATFORM_ROUTES, type PlatformRoute, TOPVIEW_PLATFORM_PRICING_LINK } from "../models.js";
import { type CatalogView, readPlatformCatalog } from "../node-catalog-cache.js";
import { topviewPlatformBaseUrl } from "../node-client.js";
import type { PlatformCatalogModel, PlatformOfferPrice } from "../types.js";

export interface ModelsView {
  catalog: Omit<CatalogView, "models">;
  routes: Array<PlatformRoute & { manufacturer?: string; prices?: PlatformOfferPrice[] }>;
  /** Catalog models with no verified route (not runnable through multix yet). */
  unrouted: string[];
  pricing: string;
}

export function buildModelsView(catalog: CatalogView): ModelsView {
  const byName = new Map<string, PlatformCatalogModel>(
    catalog.models.map((m) => [m.displayName.trim().toLowerCase(), m]),
  );
  const routedNames = new Set(PLATFORM_ROUTES.map((r) => r.catalogName.toLowerCase()));
  const { models: _models, ...meta } = catalog;
  return {
    catalog: meta,
    routes: PLATFORM_ROUTES.map((r) => {
      const m = byName.get(r.catalogName.toLowerCase());
      return {
        ...r,
        ...(m?.manufacturer ? { manufacturer: m.manufacturer } : {}),
        ...(m ? { prices: m.offers } : {}),
      };
    }),
    unrouted: catalog.models
      .map((m) => m.displayName)
      .filter((name) => !routedNames.has(name.trim().toLowerCase())),
    pricing: TOPVIEW_PLATFORM_PRICING_LINK,
  };
}

function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** One price line, e.g. `$0.103621190534 / second (video_seconds) [resolution=2K]`. */
export function formatPrice(p: PlatformOfferPrice): string {
  const size = p.unitSize && trimDecimal(p.unitSize) !== "1" ? `${trimDecimal(p.unitSize)} ` : "";
  const unit = p.unit ? ` / ${size}${p.unit}` : "";
  const component = p.componentCode ? ` (${p.componentCode})` : "";
  const spec = Object.entries(p.spec)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `$${p.saleUnitUsd ?? "?"}${unit}${component}${spec ? ` [${spec}]` : ""}`;
}

function describeCatalog(c: ModelsView["catalog"]): string {
  switch (c.state) {
    case "fresh":
      return `fetched ${c.fetched_at}`;
    case "cached":
      return `cached, fetched ${c.fetched_at}`;
    case "stale":
      return `stale copy fetched ${c.fetched_at} (refresh failed: ${c.error})`;
    default:
      return `unavailable (${c.error}); prices omitted`;
  }
}

export function registerTopviewModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description(
      "API Platform: verified routes for `topview run`, with live catalog prices (no key needed)",
    )
    .option("--json", "Print JSON")
    .option("--refresh", "Refetch the catalog instead of using the cached copy")
    .action(async (opts: { json?: boolean; refresh?: boolean }) => {
      const catalog = await readPlatformCatalog({
        baseUrl: topviewPlatformBaseUrl(),
        refresh: opts.refresh ?? false,
      });
      const view = buildModelsView(catalog);
      if (opts.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      console.log(`TopView API Platform routes (catalog ${describeCatalog(view.catalog)})`);
      if (view.catalog.truncated) {
        console.log("  Note: the catalog has more pages; only the first was read.");
      }
      let current = "";
      for (const r of view.routes) {
        if (r.catalogName !== current) {
          current = r.catalogName;
          console.log(`\n${r.catalogName} (${r.category}; ${r.family} body)`);
          if (r.prices === undefined) {
            console.log("  prices: not in the catalog");
          } else {
            const lines = [...new Set(r.prices.map(formatPrice))];
            const asOf = r.prices.find((p) => p.referenceAsOf)?.referenceAsOf;
            console.log(`  prices${asOf ? ` (provider reference as of ${asOf})` : ""}:`);
            for (const line of lines.slice(0, 12)) console.log(`    ${line}`);
            if (lines.length > 12) console.log(`    ... ${lines.length - 12} more (use --json)`);
          }
          console.log(`  verified ${r.verified_at} from ${r.source}`);
        }
        console.log(`  route: ${r.route}`);
      }
      if (view.unrouted.length > 0) {
        console.log(
          `\nIn the catalog but not yet verified for \`topview run\`: ${view.unrouted.join(", ")}`,
        );
      }
      console.log(
        `\nPricing: ${view.pricing}. Costs are charged to the separate API Platform USD balance.`,
      );
    });
}
