/**
 * Node-only: the public API Platform model and price catalog
 * (GET /platform/v1/models), cached on disk with the same conventions as
 * `multix models --live`: ~/.multix/cache/models/topview-platform.json
 * (MULTIX_CACHE_DIR overrides the directory, MULTIX_MODELS_TTL the TTL in
 * seconds). A failed read falls back to the last cached copy (state "stale")
 * while it is younger than MAX_MODELS_TTL_S. Never throws.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_MODELS_TTL_S,
  modelsCacheDir,
  modelsTtlSeconds,
} from "../../commands/agent/model-discovery-cache.js";
import type { FetchLike } from "../../core/fetch-json.js";
import { PLATFORM_CATALOG_PATH } from "./models.js";
import { fetchPlatformCatalog } from "./platform-client.js";
import type { PlatformCatalogModel } from "./types.js";

const CACHE_SCHEMA = "multix.topview-platform-catalog/v1";
const CACHE_FILE = "topview-platform.json";

export interface CatalogView {
  state: "fresh" | "cached" | "stale" | "unavailable";
  url: string;
  fetched_at?: string;
  truncated?: boolean;
  error?: string;
  models: PlatformCatalogModel[];
}

interface CacheFile {
  schema: string;
  url: string;
  fetched_at: string;
  truncated?: boolean;
  models: PlatformCatalogModel[];
}

function readCache(file: string, url: string): CacheFile | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (
      data.schema !== CACHE_SCHEMA ||
      data.url !== url ||
      typeof data.fetched_at !== "string" ||
      Number.isNaN(Date.parse(data.fetched_at)) ||
      !Array.isArray(data.models)
    ) {
      return undefined;
    }
    const models = data.models.filter(
      (m): m is PlatformCatalogModel =>
        typeof m === "object" &&
        m !== null &&
        typeof m.displayName === "string" &&
        Array.isArray(m.offers),
    );
    return { ...(data as CacheFile), models };
  } catch {
    return undefined; // missing or corrupt: treat as no cache
  }
}

function writeCache(file: string, data: CacheFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
}

export interface ReadCatalogOptions {
  baseUrl: string;
  refresh?: boolean;
  fetch?: FetchLike;
  dir?: string;
  ttlSeconds?: number;
  now?: () => number;
}

/** The catalog: fresh, cached, stale or unavailable. */
export async function readPlatformCatalog(opts: ReadCatalogOptions): Promise<CatalogView> {
  const now = opts.now ?? Date.now;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${PLATFORM_CATALOG_PATH}`;
  const file = path.join(opts.dir ?? modelsCacheDir(), CACHE_FILE);
  const cached = readCache(file, url);
  const ttlMs = (opts.ttlSeconds ?? modelsTtlSeconds()) * 1000;
  const age = cached ? now() - Date.parse(cached.fetched_at) : Number.NaN;
  const view = (c: CacheFile, state: CatalogView["state"], error?: string): CatalogView => ({
    state,
    url: c.url,
    fetched_at: c.fetched_at,
    ...(c.truncated ? { truncated: true } : {}),
    ...(error ? { error } : {}),
    models: c.models,
  });
  // A future fetched_at (clock change, edited file) counts as expired.
  if (cached && !opts.refresh && age >= 0 && age < ttlMs) return view(cached, "cached");
  try {
    const read = await fetchPlatformCatalog({ baseUrl: opts.baseUrl, fetch: opts.fetch });
    const data: CacheFile = {
      schema: CACHE_SCHEMA,
      url,
      fetched_at: new Date(now()).toISOString(),
      ...(read.truncated ? { truncated: true } : {}),
      models: read.models,
    };
    try {
      writeCache(file, data);
    } catch {
      // An unwritable cache only costs a refetch next time.
    }
    return view(data, "fresh");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached && age >= 0 && age < MAX_MODELS_TTL_S * 1000) return view(cached, "stale", error);
    return { state: "unavailable", url, error, models: [] };
  }
}
