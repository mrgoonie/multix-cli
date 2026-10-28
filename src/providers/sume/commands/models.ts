/**
 * multix sume models — the live Sume catalog (GET /v1/open/catalog, no key
 * needed), cached like `multix models --live`. Prints ids, kind, modes,
 * capabilities and list prices as Sume publishes them, with the catalog's
 * source URL, read time and state.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { routerFor } from "../catalog.js";
import type { SumeCatalogModel } from "../types.js";
import { loadSumeCatalog } from "./catalog-cache.js";
import { sumeBaseUrl } from "./env.js";

interface ModelsFlags {
  kind?: string;
  mode?: string;
  model?: string;
  refresh?: boolean;
  json?: boolean;
}

/** A model as `sume models` reports it; fields Sume does not publish stay absent. */
export function describeModel(m: SumeCatalogModel) {
  const router = routerFor(m);
  const routes = m.capabilities?.routes;
  const supported = router !== undefined && !(Array.isArray(routes) && routes.length > 0);
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    kind: m.kind ?? null,
    modes: m.modes ?? [],
    command: supported ? `multix sume ${router}` : null,
    pricing: m.pricing
      ? {
          unit: m.pricing.unit ?? null,
          from_usd: m.pricing.from_usd ?? null,
          to_usd: m.pricing.to_usd ?? null,
          ...(m.pricing.qualifier ? { qualifier: m.pricing.qualifier } : {}),
        }
      : null,
    capabilities: m.capabilities ?? {},
    ...(m.request_fields ? { request_fields: m.request_fields } : {}),
    ...(m.constraints?.length ? { constraints: m.constraints } : {}),
  };
}

function price(m: SumeCatalogModel): string {
  const p = m.pricing;
  if (!p?.from_usd) return "price unknown";
  const range =
    p.to_usd && p.to_usd !== p.from_usd ? `$${p.from_usd}–$${p.to_usd}` : `$${p.from_usd}`;
  return `${range}/${p.unit ?? "?"}`;
}

export function registerSumeModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List Sume models from the live public catalog (cached; --refresh to reread)")
    .option("--kind <kind>", "Only this kind (image, video, lipsync, captions)")
    .option("--mode <mode>", "Only models listing this mode (e.g. text-to-video)")
    .option("--model <id>", "Full catalog entry for one model id")
    .option("--refresh", "Reread the catalog even when the cached copy is fresh")
    .action(async (opts: ModelsFlags) => {
      const read = await loadSumeCatalog({ refresh: opts.refresh, baseUrl: sumeBaseUrl() });
      const { source } = read;
      if (source.state === "unavailable") {
        throw new ValidationError(`The Sume catalog is unavailable: ${source.error}`);
      }
      if (opts.model !== undefined) {
        const m = read.models.find((x) => x.id === opts.model);
        if (!m) {
          throw new ValidationError(
            `Sume model "${opts.model}" is not in the catalog (model not found).`,
          );
        }
        const data = { source, model: describeModel(m) };
        run.data = data;
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const models = read.models.filter(
        (m) =>
          (opts.kind === undefined || m.kind === opts.kind) &&
          (opts.mode === undefined || (m.modes ?? []).includes(opts.mode)),
      );
      run.data = { source, models: models.map(describeModel) };
      if (run.json || opts.json) {
        console.log(JSON.stringify(run.data, null, 2));
        return;
      }
      const when = source.fetched_at ? ` read ${source.fetched_at}` : "";
      const why = source.error ? ` (live read failed: ${source.error})` : "";
      console.log(
        `Sume catalog: ${models.length} model(s), ${source.state}${when}, ${source.url}${why}`,
      );
      for (const m of models) {
        const modes = (m.modes ?? []).join(", ") || "-";
        console.log(`  ${m.id}  [${m.kind ?? "?"}]  ${modes}  ${price(m)}`);
      }
    });
}
