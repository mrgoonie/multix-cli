/**
 * The models each `multix generate` provider can run for a task, for
 * `multix models --task <task> --live`. A provider with a model list (public
 * catalog or keyed API) is read live and cached like the fal and OpenRouter
 * catalogs (model-discovery-cache.ts); one without, or one whose list cannot
 * be read now (no key, network error), falls back to the models multix knows
 * offline. Every provider serving the task is listed, with or without a key.
 */

import type { DiscoveredModel, DiscoveryState, Task } from "../../capabilities/capability-types.js";
import type { CatalogRead } from "../../capabilities/model-discovery.js";
import type { CatalogResult } from "../../capabilities/model-views.js";
import { resolveKey } from "../../core/env-loader.js";
import { fetchJson } from "../../core/fetch-json.js";
import { DEFAULT_ATLAS_BASE_URL } from "../../providers/atlascloud/models.js";
import { createLeonardoClient } from "../../providers/leonardo/client.js";
import type { ListPlatformModelsResponse } from "../../providers/leonardo/types.js";
import { listVideoModels } from "../../providers/openrouter/video-client.js";
import { replicateBaseUrl, resolveReplicateToken } from "../../providers/replicate/node-client.js";
import { listingCatalog } from "../../providers/sume/node-catalog.js";
import { createSumeCatalogClient } from "../../providers/sume/node-client.js";
import { readPlatformCatalog } from "../../providers/topview/node-catalog-cache.js";
import { topviewPlatformBaseUrl } from "../../providers/topview/node-client.js";
import { cachedCatalog, discoverCatalog } from "../agent/model-discovery-cache.js";
import { groupKeyNames, groupReady } from "../agent/provider-group-keys.js";
import {
  GENERATE_ADAPTERS,
  type GenerateTask,
  type ModelEntry,
  providersFor,
  topviewVideoModels,
} from "./generate-adapters.js";

export interface ProviderModelsSource {
  /** "live": read from the provider's list; "static": the models multix knows offline. */
  kind: "live" | "static";
  /** Live reads: fresh, cached or stale (a cached copy used after a failed read). */
  state?: DiscoveryState;
  url?: string;
  fetched_at?: string;
  truncated?: boolean;
  /** Why the live list was not used (no key, network error). */
  error?: string;
}

export interface ProviderModels {
  provider: string;
  task: GenerateTask;
  /** The provider's key is set. */
  ready: boolean;
  /** Key env names, when not ready. */
  keys?: string[];
  /** How to run one of these models. */
  command: string;
  default_model?: string;
  /** The provider command passes any model id it serves through, listed or not. */
  any_model: boolean;
  source: ProviderModelsSource;
  models: ModelEntry[];
}

export interface GenerateModelsOptions {
  provider?: string;
  refresh?: boolean;
}

/** One list read: the capability task it covers and how to read it. */
interface LiveList {
  task: Task;
  read: () => Promise<CatalogResult>;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function model(provider: string, task: Task, id: unknown, name?: unknown): DiscoveredModel[] {
  const m = str(id);
  if (!m) return [];
  const label = str(name);
  return [{ provider, model: m, task, ...(label ? { name: label } : {}) }];
}

/** Atlas Cloud categories per capability task (public GET /models). */
const ATLAS_CATEGORIES: Partial<Record<Task, string>> = {
  image: "TEXT-TO-IMAGE",
  "image-edit": "IMAGE-TO-IMAGE",
  video: "TEXT-TO-VIDEO",
  "image-to-video": "IMAGE-TO-VIDEO",
};

async function readAtlas(task: Task): Promise<CatalogRead> {
  const url = `${DEFAULT_ATLAS_BASE_URL}/models`;
  const body = await fetchJson<{ data?: unknown }>({ url, timeoutMs: 15_000 });
  if (!Array.isArray(body.data)) throw new Error("Atlas Cloud catalog response has no data list");
  const category = ATLAS_CATEGORIES[task];
  const models = (body.data as Array<Record<string, unknown>>).flatMap((m) =>
    Array.isArray(m.categories) && m.categories.includes(category)
      ? model("atlas", task, m.model, m.displayName)
      : [],
  );
  return { url, models };
}

/** Replicate collections per capability task (GET /v1/collections/{slug}, keyed). */
const REPLICATE_COLLECTIONS: Partial<Record<Task, string>> = {
  image: "text-to-image",
  video: "text-to-video",
  "image-to-video": "image-to-video",
};

async function readReplicate(task: Task, token: string): Promise<CatalogRead> {
  const url = `${replicateBaseUrl()}/collections/${REPLICATE_COLLECTIONS[task]}`;
  const body = await fetchJson<{ models?: unknown }>({
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  if (!Array.isArray(body.models))
    throw new Error("Replicate collection response has no models list");
  const models = (body.models as Array<Record<string, unknown>>).flatMap((m) => {
    const owner = str(m.owner);
    const name = str(m.name);
    return owner && name ? model("replicate", task, `${owner}/${name}`, m.description) : [];
  });
  return { url, models };
}

async function readLeonardo(): Promise<CatalogRead> {
  const res = await createLeonardoClient().get<ListPlatformModelsResponse>("/platformModels");
  if (!Array.isArray(res.custom_models)) throw new Error("Leonardo response has no custom_models");
  return {
    url: "https://cloud.leonardo.ai/api/rest/v1/platformModels",
    models: res.custom_models.flatMap((m) => model("leonardo", "image", m.id, m.name)),
  };
}

async function readOpenRouterVideo(key: string): Promise<CatalogRead> {
  const res = await listVideoModels(key);
  const list = res.data ?? res.models;
  if (!Array.isArray(list)) throw new Error("OpenRouter video models response has no list");
  return {
    url: "https://openrouter.ai/api/v1/videos/models",
    models: list.flatMap((m) => model("openrouter", "image-to-video", m.id, m.name)),
  };
}

const key = (name: string) => resolveKey(name)?.trim() || undefined;

/**
 * The live lists of `provider` for capability tasks `tasks`, or a reason
 * there are none now. Providers not named here have no list to read.
 */
function liveLists(
  provider: string,
  tasks: readonly Task[],
  refresh: boolean,
): LiveList[] | { error: string } | undefined {
  const opts = { refresh };
  const each = (
    fn: (t: Task) => () => Promise<CatalogResult>,
    only: Partial<Record<Task, unknown>>,
  ) => tasks.filter((t) => only[t] !== undefined).map((t) => ({ task: t, read: fn(t) }));
  switch (provider) {
    case "fal":
      return each((t) => () => discoverCatalog("fal", t, opts), {
        image: 1,
        video: 1,
        "image-to-video": 1,
      });
    case "openrouter": {
      const lists = each((t) => () => discoverCatalog("openrouter", t, opts), {
        image: 1,
        "image-edit": 1,
      });
      if (!tasks.includes("image-to-video")) return lists;
      const k = key("OPENROUTER_API_KEY");
      if (!k)
        return lists.length ? lists : { error: "the video model list needs OPENROUTER_API_KEY" };
      return [
        ...lists,
        {
          task: "image-to-video",
          read: () =>
            cachedCatalog("openrouter", "image-to-video", () => readOpenRouterVideo(k), opts),
        },
      ];
    }
    case "atlas":
      return each(
        (t) => () => cachedCatalog("atlas", t, () => readAtlas(t), opts),
        ATLAS_CATEGORIES,
      );
    case "replicate": {
      const token = resolveReplicateToken()?.token;
      if (!token) return { error: "the collections API needs REPLICATE_API_TOKEN" };
      return each(
        (t) => () => cachedCatalog("replicate", t, () => readReplicate(t, token), opts),
        REPLICATE_COLLECTIONS,
      );
    }
    case "leonardo":
      if (!tasks.includes("image")) return undefined;
      if (!key("LEONARDO_API_KEY")) return { error: "the model list needs LEONARDO_API_KEY" };
      return [
        { task: "image", read: () => cachedCatalog("leonardo", "image", readLeonardo, opts) },
      ];
    default:
      return undefined;
  }
}

/** Merge entries by id, joining their tasks. */
function mergeEntries(entries: ModelEntry[]): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();
  for (const e of entries) {
    const found = byId.get(e.id);
    if (!found) byId.set(e.id, { ...e, tasks: [...e.tasks] });
    else {
      for (const t of e.tasks) if (!found.tasks.includes(t)) found.tasks.push(t);
      if (!found.label && e.label) found.label = e.label;
    }
  }
  return [...byId.values()];
}

/** Sume's public catalog: image, video and lip-sync models (captions are not generation). */
async function sumeModels(
  task: GenerateTask,
  refresh: boolean,
): Promise<{ source: ProviderModelsSource; models: ModelEntry[] }> {
  const kinds: Record<GenerateTask, string | undefined> = {
    image: "image",
    video: "video",
    lipsync: "lipsync",
    upscale: undefined,
  };
  const loaded = await listingCatalog(createSumeCatalogClient(), refresh);
  const models = loaded.catalog.models
    .filter((m) => m.kind === kinds[task])
    .map((m): ModelEntry => {
      const modes = m.modes.join(" ");
      const tasks: Task[] =
        task === "image"
          ? ["image", ...(/edit|image-to-image/.test(modes) ? (["image-edit"] as Task[]) : [])]
          : task === "video"
            ? [
                "video",
                ...(/image-to-video|i2v|first/.test(modes) ? (["image-to-video"] as Task[]) : []),
              ]
            : ["lipsync"];
      return { id: m.id, ...(m.name ? { label: m.name } : {}), tasks };
    });
  return {
    source: {
      kind: "live",
      state: loaded.state,
      url: loaded.url,
      fetched_at: loaded.fetched_at,
      ...(loaded.error ? { error: loaded.error } : {}),
    },
    models,
  };
}

/** TopView's verified routes, checked against its public catalog when it can be read. */
async function topviewModels(
  task: GenerateTask,
  refresh: boolean,
  fallback: ModelEntry[],
): Promise<{ source: ProviderModelsSource; models: ModelEntry[] }> {
  const catalog = await readPlatformCatalog({ baseUrl: topviewPlatformBaseUrl(), refresh });
  if (catalog.state === "unavailable") {
    return { source: { kind: "static", error: catalog.error }, models: fallback };
  }
  const listed = new Set(catalog.models.map((m) => m.displayName.trim().toLowerCase()));
  const routes = task === "video" ? topviewVideoModels() : fallback;
  return {
    source: {
      kind: "live",
      state: catalog.state,
      url: catalog.url,
      ...(catalog.fetched_at ? { fetched_at: catalog.fetched_at } : {}),
      ...(catalog.truncated ? { truncated: true } : {}),
      ...(catalog.error ? { error: catalog.error } : {}),
    },
    // A truncated catalog cannot prove a route gone.
    models: catalog.truncated
      ? routes
      : routes.filter((m) => !m.label || listed.has(m.label.toLowerCase())),
  };
}

async function providerModels(
  provider: string,
  task: GenerateTask,
  refresh: boolean,
): Promise<ProviderModels> {
  const adapter = GENERATE_ADAPTERS[provider];
  if (!adapter) throw new Error(`no generate adapter for ${provider}`);
  const tasks = adapter.serves[task] ?? [];
  const ready = groupReady(provider);
  const fixed = adapter.staticModels(task);
  const def = adapter.defaultModel?.(task);
  const base = {
    provider,
    task,
    ready,
    ...(ready ? {} : { keys: groupKeyNames(provider) }),
    command: `multix generate ${task} --provider ${provider} --model <id>`,
    ...(def ? { default_model: def } : {}),
    any_model: adapter.anyModel?.(task) ?? false,
  };
  const staticResult = (error?: string): ProviderModels => ({
    ...base,
    source: { kind: "static", ...(error ? { error } : {}) },
    models: fixed,
  });
  try {
    if (provider === "sume") return { ...base, ...(await sumeModels(task, refresh)) };
    if (provider === "topview") return { ...base, ...(await topviewModels(task, refresh, fixed)) };
  } catch (error) {
    return staticResult(error instanceof Error ? error.message : String(error));
  }
  const lists = liveLists(provider, tasks, refresh);
  if (lists === undefined) return staticResult();
  if ("error" in lists) return staticResult(lists.error);
  if (lists.length === 0) return staticResult();
  const results = await Promise.all(lists.map((l) => l.read()));
  const read = results.filter(
    (r) => r.source.state !== "unavailable" && r.source.state !== "unsupported",
  );
  const failed = results.find((r) => r.source.state === "unavailable");
  if (read.length === 0) return staticResult(failed?.source.error ?? "no model list for this task");
  const first = read[0]?.source;
  const live: ModelEntry[] = read.flatMap((r) =>
    r.models.map((m) => ({
      id: m.model,
      ...(m.name ? { label: m.name } : {}),
      tasks: [r.source.task],
    })),
  );
  // Tasks no list covers (fal has no edit command; OpenRouter video needs a key) keep their static models.
  const covered = new Set(read.map((r) => r.source.task));
  const uncovered = fixed.filter((m) => m.tasks.some((t) => !covered.has(t)));
  const stale = read.find((r) => r.source.state === "stale");
  return {
    ...base,
    source: {
      kind: "live",
      state: stale ? "stale" : read.every((r) => r.source.state === "cached") ? "cached" : "fresh",
      ...(first?.url ? { url: first.url } : {}),
      ...(first?.fetched_at ? { fetched_at: first.fetched_at } : {}),
      ...(read.some((r) => r.source.truncated) ? { truncated: true } : {}),
      ...((stale ?? failed)?.source.error ? { error: (stale ?? failed)?.source.error } : {}),
    },
    models: mergeEntries([...live, ...uncovered]),
  };
}

/** Every provider serving `task` with the models it can run now. Never throws. */
export async function generateProviderModels(
  task: GenerateTask,
  opts: GenerateModelsOptions = {},
): Promise<ProviderModels[]> {
  const providers = providersFor(task).filter((p) => !opts.provider || p === opts.provider);
  return Promise.all(providers.map((p) => providerModels(p, task, opts.refresh ?? false)));
}
