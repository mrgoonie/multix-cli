/**
 * The Sume catalog for the CLI, cached on disk with the same TTL and states
 * as `multix models --live`: "fresh" (just read), "cached" (younger than
 * MULTIX_MODELS_TTL), "stale" (the read failed; a copy younger than the 7-day
 * ceiling is used) or "unavailable" (no usable copy: nothing is confirmed).
 *
 * Cache: <MULTIX_CACHE_DIR or ~/.multix/cache>/models/sume-catalog.json.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITY_SCHEMA } from "../../../capabilities/capability-types.js";
import {
  MAX_MODELS_TTL_S,
  modelsCacheDir,
  modelsTtlSeconds,
} from "../../../commands/agent/model-discovery-cache.js";
import type { FetchLike } from "../../../core/fetch-json.js";
import { fetchSumeCatalog } from "../catalog.js";
import { SUME_PROVIDER } from "../models.js";
import type { SumeCatalogModel } from "../types.js";

export type SumeCatalogState = "fresh" | "cached" | "stale" | "unavailable";

export interface SumeCatalogSource {
  provider: typeof SUME_PROVIDER;
  state: SumeCatalogState;
  url?: string;
  fetched_at?: string;
  error?: string;
}

export interface SumeCatalogRead {
  source: SumeCatalogSource;
  models: SumeCatalogModel[];
}

interface CacheFile {
  schema: string;
  provider: string;
  url: string;
  fetched_at: string;
  models: SumeCatalogModel[];
}

export interface LoadCatalogOptions {
  refresh?: boolean;
  fetch?: FetchLike;
  baseUrl?: string;
  dir?: string;
  ttlSeconds?: number;
  now?: () => number;
}

const CACHE_NAME = "sume-catalog.json";

function readCache(file: string): CacheFile | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (
      data.schema !== CAPABILITY_SCHEMA ||
      data.provider !== SUME_PROVIDER ||
      typeof data.url !== "string" ||
      typeof data.fetched_at !== "string" ||
      Number.isNaN(Date.parse(data.fetched_at)) ||
      !Array.isArray(data.models)
    ) {
      return undefined;
    }
    const models = data.models.filter(
      (m): m is SumeCatalogModel => !!m && typeof m.id === "string" && m.id.length > 0,
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

function fromCache(cached: CacheFile, state: "cached" | "stale", error?: string): SumeCatalogRead {
  return {
    source: {
      provider: SUME_PROVIDER,
      state,
      url: cached.url,
      fetched_at: cached.fetched_at,
      ...(error ? { error } : {}),
    },
    models: cached.models,
  };
}

/** The catalog: fresh, cached, stale or unavailable. Never throws. */
export async function loadSumeCatalog(opts: LoadCatalogOptions = {}): Promise<SumeCatalogRead> {
  const now = opts.now ?? Date.now;
  const file = path.join(opts.dir ?? modelsCacheDir(), CACHE_NAME);
  const cached = readCache(file);
  const ttlMs = (opts.ttlSeconds ?? modelsTtlSeconds()) * 1000;
  const age = cached ? now() - Date.parse(cached.fetched_at) : Number.NaN;
  // A copy read from another base URL does not describe this one.
  const sameUrl = (url: string) =>
    !opts.baseUrl || url.startsWith(opts.baseUrl.replace(/\/+$/, ""));
  const usable = cached && sameUrl(cached.url) ? cached : undefined;
  // A future fetched_at (clock change, edited file) counts as expired, not fresh forever.
  if (usable && !opts.refresh && age >= 0 && age < ttlMs) return fromCache(usable, "cached");
  try {
    const read = await fetchSumeCatalog({ baseUrl: opts.baseUrl, fetch: opts.fetch });
    const data: CacheFile = {
      schema: CAPABILITY_SCHEMA,
      provider: SUME_PROVIDER,
      url: read.url,
      fetched_at: new Date(now()).toISOString(),
      models: read.models,
    };
    try {
      writeCache(file, data);
    } catch {
      // An unwritable cache only costs a refetch next time.
    }
    return {
      source: {
        provider: SUME_PROVIDER,
        state: "fresh",
        url: read.url,
        fetched_at: data.fetched_at,
      },
      models: read.models,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (usable && age >= 0 && age < MAX_MODELS_TTL_S * 1000)
      return fromCache(usable, "stale", error);
    const why = age < 0 ? "is dated in the future" : "is too old to use";
    const tooOld = usable ? `; cached copy from ${usable.fetched_at} ${why}` : "";
    return {
      source: { provider: SUME_PROVIDER, state: "unavailable", error: `${error}${tooOld}` },
      models: [],
    };
  }
}
