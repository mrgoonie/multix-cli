/**
 * Fish Audio voice models (runtime-neutral: no `node:*` imports; the caller
 * passes the key and `fetch`). GET /model lists voice models, your own with
 * `self=true`; GET /model/{id} reads one. Both are free, read-only calls.
 * Docs: https://docs.fish.audio/api-reference/endpoint/model/get-model
 */

import { ProviderError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { FISH_API_BASE } from "./models.js";
import { fishHeaders } from "./tts-client.js";

export interface FishVoice {
  id: string;
  title: string | null;
  type: string | null;
  /** created, training, trained or failed. */
  state: string | null;
  visibility: string | null;
  train_mode: string | null;
  languages: string[];
  tags: string[];
  created_at: string | null;
  author: string | null;
}

export interface FishVoicePage {
  total: number | null;
  has_more: boolean;
  items: FishVoice[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

export function parseFishVoice(raw: unknown): FishVoice | undefined {
  const m = raw as Record<string, unknown> | null;
  const id = str(m?._id) ?? str(m?.id);
  if (!m || !id) return undefined;
  const author = m.author as Record<string, unknown> | undefined;
  return {
    id,
    title: str(m.title),
    type: str(m.type),
    state: str(m.state),
    visibility: str(m.visibility),
    train_mode: str(m.train_mode),
    languages: strings(m.languages),
    tags: strings(m.tags),
    created_at: str(m.created_at),
    author: str(author?.nickname) ?? str(author?._id),
  };
}

export async function listFishVoices(opts: {
  apiKey: string;
  self?: boolean;
  pageSize?: number;
  pageNumber?: number;
  title?: string;
  language?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<FishVoicePage> {
  const params = new URLSearchParams();
  if (opts.self) params.set("self", "true");
  params.set("page_size", String(opts.pageSize ?? 20));
  params.set("page_number", String(opts.pageNumber ?? 1));
  if (opts.title) params.set("title", opts.title);
  if (opts.language) params.set("language", opts.language);
  const body = await fetchJson<{ items?: unknown; total?: unknown; has_more?: unknown }>({
    url: `${opts.baseUrl ?? FISH_API_BASE}/model?${params}`,
    headers: fishHeaders(opts.apiKey),
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
    fetch: opts.fetch,
  });
  if (!Array.isArray(body?.items)) {
    throw new ProviderError("Fish Audio model list has no items array", "fish");
  }
  return {
    total: typeof body.total === "number" ? body.total : null,
    // has_more may be null; fall back to the total when Fish gives one.
    has_more:
      typeof body.has_more === "boolean"
        ? body.has_more
        : typeof body.total === "number" &&
          (opts.pageNumber ?? 1) * (opts.pageSize ?? 20) < body.total,
    items: body.items.map(parseFishVoice).filter((v): v is FishVoice => v !== undefined),
  };
}

export async function getFishVoice(opts: {
  apiKey: string;
  id: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<FishVoice> {
  const body = await fetchJson<unknown>({
    url: `${opts.baseUrl ?? FISH_API_BASE}/model/${encodeURIComponent(opts.id)}`,
    headers: fishHeaders(opts.apiKey),
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
    fetch: opts.fetch,
  });
  const voice = parseFishVoice(body);
  if (!voice) throw new ProviderError(`Fish Audio returned no model for ${opts.id}`, "fish");
  return voice;
}
