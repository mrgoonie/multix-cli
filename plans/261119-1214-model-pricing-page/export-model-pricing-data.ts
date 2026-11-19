/**
 * Exports the multix model catalogue (verified capabilities + rate cards +
 * audio price book + command capabilities) to JSON for the pricing preview.
 * Offline: release dates come only from the local `multix models --live` cache.
 * Run: node plans/261119-1214-model-pricing-page/build-preview.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMMAND_CAPABILITIES } from "../../src/capabilities/command-capabilities.js";
import { MODEL_CAPABILITIES } from "../../src/capabilities/model-registry.js";
import {
  PROVIDER_INFO,
  buildOfferings,
  withReleaseDates,
} from "../../src/catalog/catalog-build.js";
import { modelsCacheDir } from "../../src/commands/agent/model-discovery-cache.js";

const at = new Date();
/** Provider catalog listings cached by `multix models --live` (any age; marked with fetched_at). */
const dir = modelsCacheDir();
const discovered: Array<Record<string, unknown>> = [];
const listings: Array<{
  file: string;
  provider: string;
  task: string;
  fetched_at: string;
  count: number;
}> = [];
for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []) {
  const d = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  if (!Array.isArray(d.models) || !d.provider) continue;
  listings.push({
    file: f,
    provider: d.provider,
    task: d.task,
    fetched_at: d.fetched_at,
    count: d.models.length,
  });
  for (const m of d.models) discovered.push({ ...m, fetched_at: d.fetched_at, listing_url: d.url });
}
const dates = new Map(
  discovered
    .filter((m) => m.released_at)
    .map((m) => [
      `${m.provider}\n${m.model}`,
      {
        released_at: m.released_at as string,
        released_source: m.released_source as "provider_listing",
      },
    ]),
);
const offerings = withReleaseDates(buildOfferings(at), (p, m) => dates.get(`${p}\n${m}`));
const capById = new Map(MODEL_CAPABILITIES.map((c) => [`${c.provider}:${c.model}`, c]));
const rows = offerings.map((o) => {
  const cap = capById.get(o.id);
  return { ...o, capability_source: cap?.source };
});
const out = {
  generated_at: at.toISOString(),
  providers: PROVIDER_INFO,
  commands: COMMAND_CAPABILITIES,
  offerings: rows,
  listings,
  discovered,
};
writeFileSync(process.argv[2] ?? "model-pricing-data.json", JSON.stringify(out, null, 1));
console.log(`offerings=${rows.length}`);
