/**
 * The read-only catalogue views shared by `multix catalog --json`, the MCP
 * tool `multix_model_catalog` and `GET /api/v1/model-catalog`, so every
 * surface returns the same offerings, prices and comparisons. Readiness is
 * the caller's (local env keys in the CLI, saved keys on the server); local
 * usage, reviews and notes are not part of these views.
 */

import { TASKS, type Task, isTask } from "../capabilities/capability-types.js";
import { ValidationError } from "../core/errors.js";
import {
  type OfferingSort,
  buildOfferings,
  buildProviders,
  filterOfferings,
  findOfferings,
  sortOfferings,
} from "./catalog-build.js";
import { CATALOG_SCHEMA, type QuoteRequest } from "./catalog-types.js";
import { compareOfferings } from "./price-compare.js";

export const CATALOG_VIEWS = ["providers", "models", "show", "compare"] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];
export const OFFERING_SORTS: readonly OfferingSort[] = ["id", "provider", "price", "checked"];

export interface CatalogQuery {
  view: CatalogView;
  task?: string;
  provider?: string;
  family?: string;
  query?: string;
  priced?: boolean;
  ready?: boolean;
  /** show: "<provider>:<model>" or a model id one provider offers. */
  offering?: string;
  resolution?: string;
  duration_s?: number;
  audio?: boolean;
  aspect_ratio?: string;
  images?: number;
  sort?: string;
  at?: Date;
}

function task(value: string | undefined): Task | undefined {
  if (value === undefined) return undefined;
  if (!isTask(value))
    throw new ValidationError(`Invalid task: ${value}. Valid: ${TASKS.join(", ")}`);
  return value;
}

function positive(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0)
    throw new ValidationError(`${name} must be a positive number.`);
  return value;
}

/** The quote request a query pins. */
export function quoteRequestOf(q: CatalogQuery): QuoteRequest {
  const t = task(q.task);
  const duration = positive("duration", q.duration_s);
  const images = positive("images", q.images);
  return {
    ...(t ? { task: t } : {}),
    ...(q.resolution ? { resolution: q.resolution.toLowerCase() } : {}),
    ...(duration !== undefined ? { duration_s: duration } : {}),
    ...(q.audio !== undefined ? { audio: q.audio } : {}),
    ...(q.aspect_ratio ? { aspect_ratio: q.aspect_ratio } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(q.at ? { at: q.at } : {}),
  };
}

/**
 * One catalogue view as a JSON-ready payload. `ready` says whether the caller
 * has the keys for a provider; `groups` are the provider groups to list.
 */
export function catalogQuery(
  q: CatalogQuery,
  ready: (provider: string) => boolean,
  groups: readonly string[],
): Record<string, unknown> {
  if (!(CATALOG_VIEWS as readonly string[]).includes(q.view)) {
    throw new ValidationError(`Invalid view: ${q.view}. Valid: ${CATALOG_VIEWS.join(", ")}`);
  }
  const all = buildOfferings(q.at);
  const withReady = <T extends { provider: string }>(o: T) => ({ ...o, ready: ready(o.provider) });
  if (q.view === "providers") {
    const rows = buildProviders(all, groups, ready).filter((p) => !q.ready || p.ready);
    return { schema: CATALOG_SCHEMA, providers: rows };
  }
  if (q.view === "show") {
    if (!q.offering) throw new ValidationError("show needs an offering (<provider>:<model>).");
    const found = findOfferings(all, q.offering);
    if (found.length !== 1) {
      throw new ValidationError(
        found.length
          ? `${q.offering} is offered by ${found.map((o) => o.provider).join(", ")}; use one of ${found.map((o) => o.id).join(", ")}.`
          : `No offering ${q.offering}.`,
      );
    }
    return { schema: CATALOG_SCHEMA, offering: withReady(found[0] as (typeof found)[number]) };
  }
  const t = task(q.task);
  const base = filterOfferings(all, {
    ...(t ? { task: t } : {}),
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.family ? { family: q.family } : {}),
    ...(q.query ? { query: q.query } : {}),
    ...(q.ready ? { ready } : {}),
  });
  if (q.view === "compare") {
    return { schema: CATALOG_SCHEMA, comparison: compareOfferings(base, quoteRequestOf(q)) };
  }
  const sort = (q.sort ?? "id") as OfferingSort;
  if (!OFFERING_SORTS.includes(sort)) {
    throw new ValidationError(`Invalid sort: ${q.sort}. Valid: ${OFFERING_SORTS.join(", ")}`);
  }
  const rows = filterOfferings(base, {
    ...(q.priced ? { priced: true } : {}),
    ...(q.resolution ? { resolution: q.resolution.toLowerCase() } : {}),
    ...(q.audio !== undefined ? { audio: q.audio } : {}),
  });
  return { schema: CATALOG_SCHEMA, offerings: sortOfferings(rows, sort).map(withReady) };
}
