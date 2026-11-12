/**
 * The Atlas Cloud 3D model and price list, read through the same on-disk
 * cache, TTL and stale rules as the other `multix models --live` catalogs
 * (~/.multix/cache/models/atlas-3d.json). Used to price `atlas 3d` and
 * `atlas run <3d model>` before they run, to list the models under
 * `multix models --task 3d --live`, and to put them in `multix catalog`.
 */

import type { CatalogResult } from "../../capabilities/model-views.js";
import type { RateCard } from "../../catalog/catalog-types.js";
import {
  type Atlas3dPriceSnapshot,
  atlas3dRateCards,
  readAtlas3dCatalog,
} from "../../providers/atlascloud/pricing.js";
import { type DiscoverOptions, cachedCatalog } from "./model-discovery-cache.js";

export interface Atlas3dOptions extends DiscoverOptions {
  /** Use only a cached copy (up to the stale limit); never fetch. */
  cacheOnly?: boolean;
}

/** The 3D list (fresh, cached, stale or unavailable). Never throws. */
export function atlas3dCatalog(opts: Atlas3dOptions = {}): Promise<CatalogResult> {
  const read = opts.cacheOnly
    ? () => Promise.reject(new Error("not fetched (cached copy only)"))
    : () => readAtlas3dCatalog(opts.fetchFn ?? fetch);
  return cachedCatalog("atlas", "3d", read, opts);
}

/** The list as an estimator input; undefined when it could not be read and nothing is cached. */
export async function atlas3dPriceSnapshot(
  opts: Atlas3dOptions = {},
): Promise<Atlas3dPriceSnapshot | undefined> {
  const { source, models } = await atlas3dCatalog(opts);
  if (!source.fetched_at) return undefined;
  return {
    fetched_at: source.fetched_at,
    ...(source.error ? { error: source.error } : {}),
    models,
  };
}

/** Catalogue rate cards for the listed 3D prices; none when the list cannot be read. */
export async function atlas3dCatalogCards(opts: Atlas3dOptions = {}): Promise<RateCard[]> {
  const { source, models } = await atlas3dCatalog(opts);
  return source.fetched_at ? atlas3dRateCards(models, source.fetched_at) : [];
}
