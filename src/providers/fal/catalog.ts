/**
 * fal's public model catalog (https://api.fal.ai/v1/models): endpoint ids by
 * category or search text, for `fal models`. Read-only and keyless, so the
 * fal key is never sent to this host.
 */

import { httpJson } from "../../core/http-client.js";

export const FAL_CATALOG_URL = "https://api.fal.ai/v1/models";

export interface FalCatalogModel {
  endpoint_id: string;
  display_name?: string;
  category?: string;
  status?: string;
}

interface CatalogPage {
  models?: Array<{
    endpoint_id?: unknown;
    metadata?: Record<string, unknown>;
  }>;
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface CatalogQuery {
  category?: string;
  query?: string;
  /** Stop after this many models (pages are followed until then). */
  limit: number;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** List catalog models, following `next_cursor` until `limit` models or the last page. */
export async function listFalModels(q: CatalogQuery): Promise<FalCatalogModel[]> {
  const out: FalCatalogModel[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const url = new URL(FAL_CATALOG_URL);
    url.searchParams.set("limit", String(Math.min(100, q.limit - out.length)));
    if (q.category) url.searchParams.set("category", q.category);
    if (q.query) url.searchParams.set("q", q.query);
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await httpJson<CatalogPage>({
      url: url.toString(),
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: 30_000,
    });
    const before = out.length;
    for (const m of page.models ?? []) {
      const id = text(m.endpoint_id);
      if (!id) continue;
      const meta = m.metadata ?? {};
      const display = text(meta.display_name);
      const category = text(meta.category);
      const status = text(meta.status);
      out.push({
        endpoint_id: id,
        ...(display ? { display_name: display } : {}),
        ...(category ? { category } : {}),
        ...(status ? { status } : {}),
      });
      if (out.length >= q.limit) break;
    }
    const next = page.has_more ? text(page.next_cursor) : undefined;
    // Stop on a page that adds nothing or a cursor seen before, so a
    // misbehaving catalog cannot keep us paging forever.
    if (out.length === before || (next !== undefined && seen.has(next))) break;
    if (next !== undefined) seen.add(next);
    cursor = next;
  } while (cursor && out.length < q.limit);
  return out;
}
