/**
 * The public Sume model catalog (GET /v1/open/catalog), runtime-neutral.
 * No key is sent. Model ids are kept exactly as published; nothing is inferred.
 */

import { ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { DEFAULT_SUME_BASE_URL, ROUTER_KINDS, SUME_PATHS, SUME_PROVIDER } from "./models.js";
import type { SumeCatalogModel, SumeRouter } from "./types.js";

const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;

export function sumeCatalogUrl(baseUrl = DEFAULT_SUME_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}${SUME_PATHS.catalog}`;
}

/** Models of a catalog body; throws on a body that is not the documented shape. */
export function parseSumeCatalog(body: unknown): SumeCatalogModel[] {
  const data = (body as { data?: { models?: unknown } } | null)?.data;
  if (!data || !Array.isArray(data.models)) {
    throw new ProviderError("Sume catalog response has no data.models list", SUME_PROVIDER);
  }
  return data.models.filter(
    (m): m is SumeCatalogModel =>
      !!m &&
      typeof m === "object" &&
      typeof (m as { id?: unknown }).id === "string" &&
      (m as { id: string }).id.length > 0,
  );
}

export async function fetchSumeCatalog(opts: {
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<{ url: string; models: SumeCatalogModel[] }> {
  const url = sumeCatalogUrl(opts.baseUrl);
  const body = await fetchJson<unknown>({
    url,
    headers: { Accept: "application/json" },
    timeoutMs: CATALOG_TIMEOUT_MS,
    maxBytes: CATALOG_MAX_BYTES,
    fetch: opts.fetch,
  });
  return { url, models: parseSumeCatalog(body) };
}

/** The router that serves a catalog kind, or undefined (captions and unknown kinds). */
export function routerFor(model: SumeCatalogModel): SumeRouter | undefined {
  const kind = model.kind ?? "";
  if ((ROUTER_KINDS.image as readonly string[]).includes(kind)) return "image";
  if ((ROUTER_KINDS.video as readonly string[]).includes(kind)) return "video";
  return undefined;
}

/**
 * The catalog entry for `id`, checked to be served by `router`. Exact,
 * case-sensitive match: ids are never rewritten or guessed.
 */
export function requireCatalogModel(
  models: SumeCatalogModel[],
  id: string,
  router: SumeRouter,
): SumeCatalogModel {
  const model = models.find((m) => m.id === id);
  if (!model) {
    throw new ValidationError(
      `Sume model "${id}" is not in the catalog (model not found). List models with: multix sume models --kind ${router}`,
    );
  }
  const routes = model.capabilities?.routes;
  if (Array.isArray(routes) && routes.length > 0) {
    throw new ValidationError(
      `Sume model "${id}" is served by its own route (${routes.join(", ")}), which multix does not support.`,
    );
  }
  const served = routerFor(model);
  if (served !== router) {
    const hint = served ? ` Use: multix sume ${served} -m ${id}` : "";
    throw new ValidationError(
      `Sume model "${id}" is a ${model.kind ?? "unknown"} model, not served by the ${router} router.${hint}`,
    );
  }
  return model;
}
