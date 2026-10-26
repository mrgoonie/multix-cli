/**
 * Read provider model catalogs for one task. Runtime-neutral: the caller
 * passes fetch; caching lives in the CLI layer. Both catalogs are public, so
 * no key is sent.
 */

import type { DiscoveredModel, Task } from "./capability-types.js";

export type FetchFn = typeof fetch;

export interface CatalogRead {
  url: string;
  models: DiscoveredModel[];
  truncated?: boolean;
}

/** fal catalog categories per task (https://api.fal.ai/v1/models). */
const FAL_CATEGORIES: Partial<Record<Task, string>> = {
  speech: "text-to-speech",
  transcription: "speech-to-text",
  image: "text-to-image",
  "image-edit": "image-to-image",
  video: "text-to-video",
  "image-to-video": "image-to-video",
  "video-edit": "video-to-video",
};

/** OpenRouter output modality per task (https://openrouter.ai/api/v1/models). */
const OPENROUTER_OUTPUTS: Partial<Record<Task, string>> = {
  speech: "speech",
  transcription: "transcription",
  image: "image",
  "image-edit": "image",
};

export const DISCOVERY_PROVIDERS = ["fal", "openrouter"] as const;
export type DiscoveryProvider = (typeof DISCOVERY_PROVIDERS)[number];

export function discoverySupported(provider: string, task: Task): boolean {
  if (provider === "fal") return FAL_CATEGORIES[task] !== undefined;
  if (provider === "openrouter") return OPENROUTER_OUTPUTS[task] !== undefined;
  return false;
}

const MAX_FAL_PAGES = 5;
const TIMEOUT_MS = 15_000;

async function getJson(fetchFn: FetchFn, url: string) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as unknown;
}

/** Non-empty catalog text with control characters removed (it reaches terminals). */
const str = (v: unknown) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "") : "";
  return s || undefined;
};

interface FalPage {
  models?: Array<{
    endpoint_id?: unknown;
    metadata?: { display_name?: unknown; status?: unknown };
  }>;
  has_more?: unknown;
  next_cursor?: unknown;
}

async function readFal(task: Task, fetchFn: FetchFn): Promise<CatalogRead> {
  const category = FAL_CATEGORIES[task] as string;
  const base = `https://api.fal.ai/v1/models?category=${encodeURIComponent(category)}&limit=100`;
  const models: DiscoveredModel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FAL_PAGES; page++) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    const body = (await getJson(fetchFn, url)) as FalPage;
    if (!Array.isArray(body.models)) throw new Error("fal catalog response has no models list");
    for (const m of body.models) {
      const model = str(m.endpoint_id);
      if (!model) continue;
      const name = str(m.metadata?.display_name);
      const status = str(m.metadata?.status);
      models.push({
        provider: "fal",
        model,
        task,
        ...(name ? { name } : {}),
        ...(status ? { status } : {}),
      });
    }
    cursor = body.has_more === true ? str(body.next_cursor) : undefined;
    if (!cursor) return { url: base, models };
  }
  return { url: base, models, truncated: true };
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  architecture?: { input_modalities?: unknown };
  pricing?: Record<string, unknown>;
  supported_voices?: unknown;
  expiration_date?: unknown;
}

async function readOpenRouter(task: Task, fetchFn: FetchFn): Promise<CatalogRead> {
  const output = OPENROUTER_OUTPUTS[task] as string;
  const url = `https://openrouter.ai/api/v1/models?output_modalities=${encodeURIComponent(output)}`;
  const body = (await getJson(fetchFn, url)) as { data?: OpenRouterModel[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog response has no data list");
  const models: DiscoveredModel[] = [];
  for (const m of body.data) {
    const model = str(m.id);
    if (!model) continue;
    const inputs = m.architecture?.input_modalities;
    if (task === "image-edit" && !(Array.isArray(inputs) && inputs.includes("image"))) continue;
    const name = str(m.name);
    const voices = Array.isArray(m.supported_voices)
      ? m.supported_voices.filter((v): v is string => typeof v === "string")
      : [];
    const pricing = Object.fromEntries(
      Object.entries(m.pricing ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
    models.push({
      provider: "openrouter",
      model,
      task,
      ...(name ? { name } : {}),
      ...(str(m.expiration_date) ? { status: `expires ${str(m.expiration_date)}` } : {}),
      ...(voices.length ? { voices } : {}),
      ...(Object.keys(pricing).length ? { pricing } : {}),
    });
  }
  return { url, models };
}

/** One provider catalog for one task. Throws on network, HTTP or shape errors. */
export function readCatalog(
  provider: DiscoveryProvider,
  task: Task,
  fetchFn: FetchFn,
): Promise<CatalogRead> {
  return provider === "fal" ? readFal(task, fetchFn) : readOpenRouter(task, fetchFn);
}
