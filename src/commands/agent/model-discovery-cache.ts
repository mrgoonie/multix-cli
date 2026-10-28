/**
 * Provider catalog reads for `multix models --live`, cached on disk with a
 * TTL so agents do not refetch on every call. A failed read falls back to the
 * last cached copy (state "stale") while it is younger than MAX_MODELS_TTL_S;
 * with no such copy the catalog is "unavailable" and every model it would have
 * confirmed stays unknown.
 *
 * Cache: ~/.multix/cache/models/<provider>-<task>.json, plus the whole Sume
 * catalogue in sume-catalog.json (MULTIX_CACHE_DIR overrides the directory,
 * MULTIX_MODELS_TTL the TTL in seconds).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAPABILITY_SCHEMA,
  type DiscoveredModel,
  type DiscoverySource,
  type Task,
} from "../../capabilities/capability-types.js";
import {
  type DiscoveryProvider,
  type FetchFn,
  discoverySupported,
  readCatalog,
} from "../../capabilities/model-discovery.js";
import type { CatalogResult } from "../../capabilities/model-views.js";
import { type SumeCatalog, parseSumeCatalog } from "../../providers/sume/catalog.js";
import { SUME_CATALOG_URL } from "../../providers/sume/models.js";

export const DEFAULT_MODELS_TTL_S = 24 * 60 * 60;

export function modelsCacheDir(): string {
  return process.env.MULTIX_CACHE_DIR
    ? path.resolve(process.env.MULTIX_CACHE_DIR, "models")
    : path.join(os.homedir(), ".multix", "cache", "models");
}

/** Longest TTL honoured, so a setting cannot keep a removed model "listed" for long. */
export const MAX_MODELS_TTL_S = 7 * 24 * 60 * 60;

export function modelsTtlSeconds(): number {
  const value = process.env.MULTIX_MODELS_TTL?.trim();
  const raw = value ? Number(value) : Number.NaN;
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, MAX_MODELS_TTL_S) : DEFAULT_MODELS_TTL_S;
}

interface CacheFile {
  schema: string;
  provider: string;
  task: string;
  url: string;
  fetched_at: string;
  truncated?: boolean;
  models: DiscoveredModel[];
}

function readCache(file: string, provider: string, task: Task): CacheFile | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (
      data.schema !== CAPABILITY_SCHEMA ||
      data.provider !== provider ||
      data.task !== task ||
      typeof data.fetched_at !== "string" ||
      Number.isNaN(Date.parse(data.fetched_at)) ||
      !Array.isArray(data.models)
    ) {
      return undefined;
    }
    const models = data.models.filter(
      (m): m is DiscoveredModel =>
        typeof m === "object" &&
        m !== null &&
        m.provider === provider &&
        typeof m.model === "string" &&
        m.model.length > 0,
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

export interface DiscoverOptions {
  refresh?: boolean;
  fetchFn?: FetchFn;
  dir?: string;
  ttlSeconds?: number;
  now?: () => number;
}

function fromCache(cached: CacheFile, state: "cached" | "stale", error?: string): CatalogResult {
  return {
    source: {
      provider: cached.provider,
      task: cached.task as Task,
      state,
      url: cached.url,
      fetched_at: cached.fetched_at,
      ...(cached.truncated ? { truncated: true } : {}),
      ...(error ? { error } : {}),
    },
    models: cached.models,
  };
}

/** One provider catalog for one task: fresh, cached, stale or unavailable. Never throws. */
export async function discoverCatalog(
  provider: DiscoveryProvider,
  task: Task,
  opts: DiscoverOptions = {},
): Promise<CatalogResult> {
  if (!discoverySupported(provider, task)) {
    const source: DiscoverySource = { provider, task, state: "unsupported" };
    return { source, models: [] };
  }
  const now = opts.now ?? Date.now;
  const file = path.join(opts.dir ?? modelsCacheDir(), `${provider}-${task}.json`);
  const cached = readCache(file, provider, task);
  const ttlMs = (opts.ttlSeconds ?? modelsTtlSeconds()) * 1000;
  const age = cached ? now() - Date.parse(cached.fetched_at) : Number.NaN;
  // A future fetched_at (clock change, edited file) counts as expired, not fresh forever.
  if (cached && !opts.refresh && age >= 0 && age < ttlMs) {
    return fromCache(cached, "cached");
  }
  try {
    const read = await readCatalog(provider, task, opts.fetchFn ?? fetch);
    const data: CacheFile = {
      schema: CAPABILITY_SCHEMA,
      provider,
      task,
      url: read.url,
      fetched_at: new Date(now()).toISOString(),
      ...(read.truncated ? { truncated: true } : {}),
      models: read.models,
    };
    try {
      writeCache(file, data);
    } catch {
      // An unwritable cache only costs a refetch next time.
    }
    return {
      source: {
        provider,
        task,
        state: "fresh",
        url: read.url,
        fetched_at: data.fetched_at,
        ...(read.truncated ? { truncated: true } : {}),
      },
      models: read.models,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Past the TTL ceiling (or stamped in the future) a copy is too old to confirm anything.
    if (cached && age >= 0 && age < MAX_MODELS_TTL_S * 1000) {
      return fromCache(cached, "stale", error);
    }
    const why = age < 0 ? "is dated in the future" : "is too old to use";
    const tooOld = cached ? `; cached copy from ${cached.fetched_at} ${why}` : "";
    return {
      source: { provider, task, state: "unavailable", error: `${error}${tooOld}` },
      models: [],
    };
  }
}

/** The whole Sume catalogue (every kind, with capabilities), cached for `multix sume`. */
export interface SumeCatalogResult {
  state: "fresh" | "cached" | "stale" | "unavailable";
  url?: string;
  fetched_at?: string;
  error?: string;
  catalog?: SumeCatalog;
}

interface SumeCacheFile {
  schema: string;
  provider: "sume";
  url: string;
  fetched_at: string;
  /** The catalogue response body as Sume sent it; re-parsed on every read. */
  body: unknown;
}

const SUME_CACHE_FILE = "sume-catalog.json";

function readSumeCache(file: string): (SumeCacheFile & { catalog: SumeCatalog }) | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<SumeCacheFile>;
    if (
      data.schema !== CAPABILITY_SCHEMA ||
      data.provider !== "sume" ||
      typeof data.url !== "string" ||
      typeof data.fetched_at !== "string" ||
      Number.isNaN(Date.parse(data.fetched_at))
    ) {
      return undefined;
    }
    return { ...(data as SumeCacheFile), catalog: parseSumeCatalog(data.body) };
  } catch {
    return undefined; // missing or corrupt: treat as no cache
  }
}

/**
 * The Sume catalogue with the same TTL and fallback rules as
 * `discoverCatalog`: fresh, cached (younger than the TTL), stale (a failed
 * read with a copy younger than MAX_MODELS_TTL_S) or unavailable. Never throws.
 */
export async function discoverSumeCatalog(opts: DiscoverOptions = {}): Promise<SumeCatalogResult> {
  const now = opts.now ?? Date.now;
  const file = path.join(opts.dir ?? modelsCacheDir(), SUME_CACHE_FILE);
  const cached = readSumeCache(file);
  const ttlMs = (opts.ttlSeconds ?? modelsTtlSeconds()) * 1000;
  const age = cached ? now() - Date.parse(cached.fetched_at) : Number.NaN;
  const fromSumeCache = (
    c: NonNullable<typeof cached>,
    state: "cached" | "stale",
    error?: string,
  ) => ({
    state,
    url: c.url,
    fetched_at: c.fetched_at,
    catalog: c.catalog,
    ...(error ? { error } : {}),
  });
  if (cached && !opts.refresh && age >= 0 && age < ttlMs) return fromSumeCache(cached, "cached");
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(SUME_CATALOG_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status} from ${new URL(SUME_CATALOG_URL).host}`);
    }
    const body = (await res.json()) as unknown;
    const catalog = parseSumeCatalog(body);
    const fetched_at = new Date(now()).toISOString();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const data: SumeCacheFile = {
        schema: CAPABILITY_SCHEMA,
        provider: "sume",
        url: SUME_CATALOG_URL,
        fetched_at,
        body,
      };
      writeFileSync(tmp, `${JSON.stringify(data)}\n`);
      renameSync(tmp, file);
    } catch {
      // An unwritable cache only costs a refetch next time.
    }
    return { state: "fresh", url: SUME_CATALOG_URL, fetched_at, catalog };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached && age >= 0 && age < MAX_MODELS_TTL_S * 1000) {
      return fromSumeCache(cached, "stale", error);
    }
    const why = age < 0 ? "is dated in the future" : "is too old to use";
    const tooOld = cached ? `; cached copy from ${cached.fetched_at} ${why}` : "";
    return { state: "unavailable", error: `${error}${tooOld}` };
  }
}
