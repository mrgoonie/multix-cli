/**
 * multix sume models [--kind <kind>] [--refresh] [--json] — Sume's public
 * model catalog (no key needed): id, kind, modes, list price range and a
 * capability summary. Cached on disk with a TTL (MULTIX_MODELS_TTL, 24h by
 * default); when Sume cannot be reached the cached copy is shown, marked
 * stale, or the command fails with "unavailable".
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import {
  SUME_KINDS,
  SUME_PRICING_LINK,
  capabilitySummary,
  priceSummary,
  usesSpecialRoute,
} from "../models.js";
import { listingCatalog } from "../node-catalog.js";
import { createSumeCatalogClient } from "../node-client.js";

interface ModelsOpts {
  kind?: string;
  refresh?: boolean;
  json?: boolean;
}

export function registerSumeModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List Sume's models, prices and capabilities (public catalog, cached)")
    .option("--kind <kind>", `Only this kind: ${SUME_KINDS.join(", ")}`)
    .option("--refresh", "Read the catalog from Sume now instead of the cache")
    .option("--json", "Print JSON")
    .action(async (opts: ModelsOpts) => {
      const logger = createLogger({ verbose: false, stderr: true });
      const kind = opts.kind?.trim().toLowerCase();
      if (kind !== undefined && !(SUME_KINDS as readonly string[]).includes(kind)) {
        throw new ValidationError(`--kind must be one of: ${SUME_KINDS.join(", ")}`);
      }
      const loaded = await listingCatalog(createSumeCatalogClient(), Boolean(opts.refresh));
      if (loaded.state === "stale") {
        logger.warn(
          `Could not read Sume's catalog (${loaded.error}); showing the cached copy from ${loaded.fetched_at} (stale)`,
        );
      }
      const models = loaded.catalog.models.filter((m) => !kind || m.kind === kind);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: {
                url: loaded.url,
                fetched_at: loaded.fetched_at,
                state: loaded.state,
                ...(loaded.error ? { error: loaded.error } : {}),
              },
              currency: loaded.catalog.currency,
              models,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `Sume models${kind ? ` (${kind})` : ""}: ${models.length}, catalog fetched ${loaded.fetched_at}${loaded.state === "stale" ? " (stale)" : ""}`,
      );
      for (const m of models) {
        const route = usesSpecialRoute(m) ? " (special route; not supported by multix)" : "";
        console.log(`  ${m.id}  [${m.kind}]${route}`);
        if (m.modes.length > 0) console.log(`    modes: ${m.modes.join(", ")}`);
        console.log(`    price: ${priceSummary(m)}`);
        const caps = capabilitySummary(m);
        if (caps) console.log(`    supports: ${caps}`);
      }
      console.log(
        `\nPrices: ${SUME_PRICING_LINK}. Details of one model: multix sume models --json`,
      );
    });
}
