/**
 * Node-only: the Sume public catalog, cached on disk.
 *
 * Cache: <models cache dir>/sume-catalog.json (MULTIX_CACHE_DIR overrides the
 * directory, MULTIX_MODELS_TTL the listing TTL, as for `multix models --live`).
 * A copy is used only for the catalog URL it was read from, and its rows are
 * parsed again on read, so an edited file cannot smuggle in odd values.
 *
 * - `sume models` lists a copy younger than the TTL without refetching, and
 *   falls back to an older copy (marked stale) when Sume cannot be reached.
 * - `sume image|video` read the catalog fresh before a paid request, falling
 *   back to a copy younger than 24h; the pre-flight price reads the copy only.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_MODELS_TTL_S,
  modelsCacheDir,
  modelsTtlSeconds,
} from "../../commands/agent/model-discovery-cache.js";
import { ProviderError } from "../../core/errors.js";
import type { SumeClient } from "./client.js";
import { SUME_PRICE_MAX_AGE_MS, type SumeCatalogSnapshot } from "./cost.js";
import { SUME_CATALOG_PATH, SUME_ROUTING, parseCatalogModel } from "./models.js";
import { sumeBaseUrl } from "./node-client.js";
import type { SumeCatalog, SumeModel } from "./types.js";

export const SUME_CATALOG_CACHE_SCHEMA = "multix.sume-catalog/v1";

export interface SumeCatalogCache {
  schema: typeof SUME_CATALOG_CACHE_SCHEMA;
  url: string;
  fetched_at: string;
  currency: string;
  models: SumeModel[];
}

export type SumeCatalogState = "fresh" | "cached" | "stale";

export interface LoadedSumeCatalog {
  catalog: SumeCatalog;
  url: string;
  fetched_at: string;
  state: SumeCatalogState;
  /** Why a stale copy was used (the fetch error). */
  error?: string;
}

export function sumeCatalogCacheFile(): string {
  return path.join(modelsCacheDir(), "sume-catalog.json");
}

/** The catalog URL for the configured base URL, without resolving any key. */
export function sumeCatalogUrl(): string {
  let base: string;
  try {
    base = sumeBaseUrl();
  } catch {
    // A rejected SUME_BASE_URL fails the command itself; the price lookup just finds no copy.
    base = SUME_ROUTING.defaultUrl;
  }
  return `${base.replace(/\/+$/, "")}${SUME_CATALOG_PATH}`;
}

/** The cached copy for `url`, or undefined when missing, corrupt or for another URL. Sync. */
export function readSumeCatalogCache(
  url: string = sumeCatalogUrl(),
  file: string = sumeCatalogCacheFile(),
): SumeCatalogCache | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<SumeCatalogCache>;
    if (
      data.schema !== SUME_CATALOG_CACHE_SCHEMA ||
      data.url !== url ||
      typeof data.fetched_at !== "string" ||
      Number.isNaN(Date.parse(data.fetched_at)) ||
      !Array.isArray(data.models)
    ) {
      return undefined;
    }
    const models = data.models
      .map((row) => parseCatalogModel(row))
      .filter((m): m is SumeModel => m !== undefined);
    return {
      schema: SUME_CATALOG_CACHE_SCHEMA,
      url,
      fetched_at: data.fetched_at,
      currency: typeof data.currency === "string" ? data.currency.slice(0, 10) : "USD",
      models,
    };
  } catch {
    return undefined; // missing or corrupt: treat as no cache
  }
}

export function writeSumeCatalogCache(
  url: string,
  catalog: SumeCatalog,
  fetchedAt: string,
  file: string = sumeCatalogCacheFile(),
): void {
  const data: SumeCatalogCache = {
    schema: SUME_CATALOG_CACHE_SCHEMA,
    url,
    fetched_at: fetchedAt,
    currency: catalog.currency,
    models: catalog.models,
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data)}\n`);
    renameSync(tmp, file);
  } catch {
    // An unwritable cache only costs a refetch (and an unpriced pre-flight) next time.
  }
}

function ageMs(cache: SumeCatalogCache, now: number): number {
  return now - Date.parse(cache.fetched_at);
}

function fromCache(
  cache: SumeCatalogCache,
  state: SumeCatalogState,
  error?: string,
): LoadedSumeCatalog {
  return {
    catalog: { currency: cache.currency, models: cache.models },
    url: cache.url,
    fetched_at: cache.fetched_at,
    state,
    ...(error ? { error } : {}),
  };
}

export interface LoadCatalogOptions {
  client: SumeClient;
  /** Skip a fresh copy and read Sume now. */
  refresh?: boolean;
  /** A cached copy younger than this is used without fetching (0: always fetch). */
  freshForMs: number;
  /** On a failed fetch, a copy younger than this is used, marked stale. */
  staleForMs: number;
  now?: () => number;
  file?: string;
}

/** Fetch (and cache) the catalog, or fall back to the cache; throws when neither works. */
export async function loadSumeCatalog(opts: LoadCatalogOptions): Promise<LoadedSumeCatalog> {
  const now = opts.now ?? Date.now;
  const url = opts.client.catalogUrl;
  const cached = readSumeCatalogCache(url, opts.file);
  const age = cached ? ageMs(cached, now()) : Number.NaN;
  // A future fetched_at (clock change, edited file) counts as expired.
  if (cached && !opts.refresh && age >= 0 && age < opts.freshForMs) {
    return fromCache(cached, "cached");
  }
  try {
    const catalog = await opts.client.catalog();
    const fetchedAt = new Date(now()).toISOString();
    writeSumeCatalogCache(url, catalog, fetchedAt, opts.file);
    return { catalog, url, fetched_at: fetchedAt, state: "fresh" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached && age >= 0 && age < opts.staleForMs) return fromCache(cached, "stale", message);
    const old = cached ? `; the cached copy from ${cached.fetched_at} is too old to use` : "";
    throw new ProviderError(
      `Sume model catalog unavailable: ${message}${old}. Try again later`,
      "sume",
      { cause: error },
    );
  }
}

/** For `sume models`: the listing TTL, and any copy up to the TTL ceiling when offline. */
export function listingCatalog(client: SumeClient, refresh: boolean): Promise<LoadedSumeCatalog> {
  return loadSumeCatalog({
    client,
    refresh,
    freshForMs: modelsTtlSeconds() * 1000,
    staleForMs: MAX_MODELS_TTL_S * 1000,
  });
}

/**
 * For a paid request: the catalog read now (and cached), or a copy younger
 * than 24h when Sume's catalog cannot be read. A dry run uses a fresh copy
 * so the request it shows is the generation, not the catalog read.
 */
export function requestCatalog(client: SumeClient, dryRun: boolean): Promise<LoadedSumeCatalog> {
  return loadSumeCatalog({
    client,
    freshForMs: dryRun ? SUME_PRICE_MAX_AGE_MS : 0,
    staleForMs: SUME_PRICE_MAX_AGE_MS,
  });
}

/** What the pre-flight price needs: the cached copy's date, source and the model's row. */
export function sumeCatalogSnapshot(model: string | undefined): SumeCatalogSnapshot | undefined {
  const cache = readSumeCatalogCache();
  if (!cache) return undefined;
  const row = model ? cache.models.find((m) => m.id === model) : undefined;
  return { fetched_at: cache.fetched_at, source: cache.url, ...(row ? { model: row } : {}) };
}
