/**
 * `multix_model_catalog` and `GET /api/v1/model-catalog`: the CLI's model &
 * provider catalogue (`multix catalog --json`), read-only. Offerings, prices
 * per configuration with source and check date, and configuration-aware
 * comparisons come from the same runtime-neutral code the CLI runs
 * (src/catalog). Readiness reflects the caller's saved keys, never values.
 * Usage, ratings and notes stay on the caller's machine and are not served.
 */

import { type CatalogQuery, catalogQuery } from "../../../src/catalog/catalog-query.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { hasGroupKeys } from "./catalog-view.js";
import { GROUP_KEYS } from "./cli-command-policy.js";
import { liveReleaseLookup } from "./release-dates.js";

export function modelCatalogPayload(
  keys: ProviderKeys,
  query: CatalogQuery,
): Record<string, unknown> {
  return catalogQuery(query, (provider) => hasGroupKeys(provider, keys), Object.keys(GROUP_KEYS));
}

/** Like modelCatalogPayload; `sort: "released"` also reads the public catalog listings for dates. */
export async function modelCatalogPayloadAsync(
  keys: ProviderKeys,
  query: CatalogQuery,
  fetchFn?: typeof fetch,
): Promise<Record<string, unknown>> {
  const releases = query.sort === "released" ? await liveReleaseLookup(fetchFn) : undefined;
  return catalogQuery(
    query,
    (provider) => hasGroupKeys(provider, keys),
    Object.keys(GROUP_KEYS),
    releases,
  );
}
