/**
 * Release dates for `sort=released` in the model catalogue. Read from the
 * public fal and OpenRouter catalog listings (no key sent) with the same
 * runtime-neutral reader the CLI uses, and kept in memory for an hour per
 * isolate. A catalog that cannot be read leaves its models undated (sorted
 * last), never guessed.
 */

import { TASKS } from "../../../src/capabilities/capability-types.js";
import type { ReleaseSource } from "../../../src/capabilities/capability-types.js";
import {
  DISCOVERY_PROVIDERS,
  type FetchFn,
  discoverySupported,
  readCatalog,
} from "../../../src/capabilities/model-discovery.js";
import type { ReleaseLookup } from "../../../src/catalog/catalog-build.js";

const TTL_MS = 60 * 60 * 1000;

type Dates = Map<string, { released_at: string; released_source: ReleaseSource }>;
let cache: { at: number; dates: Promise<Dates> } | undefined;

async function load(fetchFn: FetchFn): Promise<Dates> {
  const dates: Dates = new Map();
  const reads = DISCOVERY_PROVIDERS.flatMap((provider) =>
    TASKS.filter((task) => discoverySupported(provider, task)).map(async (task) => {
      try {
        const read = await readCatalog(provider, task, fetchFn);
        for (const m of read.models) {
          if (m.released_at && m.released_source) {
            dates.set(`${m.provider}\n${m.model}`, {
              released_at: m.released_at,
              released_source: m.released_source,
            });
          }
        }
      } catch {
        // An unreadable catalog only leaves its models undated.
      }
    }),
  );
  await Promise.all(reads);
  return dates;
}

export async function liveReleaseLookup(
  fetchFn: FetchFn = fetch,
  now = Date.now(),
): Promise<ReleaseLookup> {
  if (!cache || now - cache.at > TTL_MS) cache = { at: now, dates: load(fetchFn) };
  const dates = await cache.dates;
  return (provider, model) => dates.get(`${provider}\n${model}`);
}

/** Drop the in-memory copy (tests). */
export function resetReleaseDates(): void {
  cache = undefined;
}
