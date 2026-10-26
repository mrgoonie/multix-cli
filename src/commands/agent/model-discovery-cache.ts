/**
 * Provider catalog reads for `multix models --live`, cached on disk with a
 * TTL so agents do not refetch on every call. A failed read falls back to the
 * last cached copy (state "stale"); with no copy the catalog is "unavailable"
 * and every model it would have confirmed stays unknown.
 *
 * Cache: ~/.multix/cache/models/<provider>-<task>.json (MULTIX_CACHE_DIR
 * overrides the directory, MULTIX_MODELS_TTL the TTL in seconds).
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

export const DEFAULT_MODELS_TTL_S = 24 * 60 * 60;

export function modelsCacheDir(): string {
  return process.env.MULTIX_CACHE_DIR
    ? path.resolve(process.env.MULTIX_CACHE_DIR, "models")
    : path.join(os.homedir(), ".multix", "cache", "models");
}

export function modelsTtlSeconds(): number {
  const raw = Number(process.env.MULTIX_MODELS_TTL);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MODELS_TTL_S;
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
    return data as CacheFile;
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
  if (cached && !opts.refresh && now() - Date.parse(cached.fetched_at) < ttlMs) {
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
    if (cached) return fromCache(cached, "stale", error);
    return { source: { provider, task, state: "unavailable", error }, models: [] };
  }
}
