/**
 * Fish Audio voice models (runtime-neutral: no `node:*` imports; the caller
 * passes the key, `fetch` and, for a clone, the samples as Blobs). GET /model
 * lists voice models, your own with `self=true`; GET /model/{id} reads one;
 * DELETE /model/{id} removes one of yours. POST /model (multipart) creates a
 * clone and is sent once, never retried: a second request is a second voice.
 * Docs: https://docs.fish.audio/api-reference/endpoint/model/get-model,
 * https://docs.fish.audio/api-reference/endpoint/model/create-model
 */

import { ProviderError, ValidationError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { readCappedBytes } from "../../core/response-read.js";
import { FISH_API_BASE } from "./models.js";
import { fishHeaders, fishUnknownState, postFishOnce } from "./tts-client.js";

/** Sample files one clone may upload. */
export const MAX_CLONE_SAMPLES = 20;
/** "public" is published from Fish's web app; the API downgrades it to private. */
export const FISH_VISIBILITIES = ["private", "unlist"] as const;
export type FishVisibility = (typeof FISH_VISIBILITIES)[number];

const FISH_MODEL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Check a voice model id before it goes into a URL path. */
export function fishModelId(id: string): string {
  const v = id.trim();
  if (!FISH_MODEL_ID.test(v)) throw new ValidationError(`"${id}" is not a Fish Audio voice id`);
  return v;
}

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

export async function deleteFishVoice(opts: {
  apiKey: string;
  id: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<void> {
  await fetchJson<unknown>({
    url: `${opts.baseUrl ?? FISH_API_BASE}/model/${fishModelId(opts.id)}`,
    method: "DELETE",
    headers: fishHeaders(opts.apiKey),
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
    fetch: opts.fetch,
  });
}

export interface CloneSample {
  name: string;
  data: Blob;
  /** Words spoken in this sample; Fish transcribes the sample when absent. */
  text?: string;
}

export interface CreateFishCloneOptions {
  apiKey: string;
  title: string;
  samples: CloneSample[];
  description?: string;
  visibility?: FishVisibility;
  tags?: string[];
  enhanceAudioQuality?: boolean;
  /** One /v1/voice-design candidate signature per sample, in order. */
  designSignatures?: string[];
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

/** The multipart form for POST /model (type=tts, train_mode=fast). */
export function cloneForm(opts: CreateFishCloneOptions): FormData {
  const title = opts.title.trim();
  if (!title) throw new ValidationError("--title is required");
  if (opts.samples.length === 0 || opts.samples.length > MAX_CLONE_SAMPLES) {
    throw new ValidationError(`Give 1-${MAX_CLONE_SAMPLES} sample files`);
  }
  const texts = opts.samples.map((s) => s.text);
  if (texts.some((t) => t !== undefined) && texts.some((t) => t === undefined)) {
    throw new ValidationError("Give a transcript for every sample, or for none");
  }
  if (opts.designSignatures && opts.designSignatures.length !== opts.samples.length) {
    throw new ValidationError("Give one --design-signature per sample, in the same order");
  }
  const form = new FormData();
  form.append("type", "tts");
  form.append("train_mode", "fast");
  form.append("title", title);
  form.append("visibility", opts.visibility ?? "private");
  if (opts.description) form.append("description", opts.description);
  for (const tag of opts.tags ?? []) form.append("tags", tag);
  if (opts.enhanceAudioQuality === false) form.append("enhance_audio_quality", "false");
  for (const s of opts.samples) form.append("voices", s.data, s.name);
  for (const t of texts) if (t !== undefined) form.append("texts", t);
  for (const sig of opts.designSignatures ?? []) form.append("voice_design_signatures", sig);
  return form;
}

/** A voice record is small JSON; anything bigger is not one. */
const MAX_CLONE_ANSWER_BYTES = 1024 * 1024;
const VOICES_CHECK =
  "so a voice may have been created: check `multix fish voices list` before sending it again";

/**
 * Create a voice clone (sent once, never retried). Errors: ValidationError
 * before sending, HttpError for Fish's own error answer, UNKNOWN_REMOTE_STATE
 * when a voice may have been created but the answer was lost.
 */
export async function createFishClone(opts: CreateFishCloneOptions): Promise<FishVoice> {
  const url = `${opts.baseUrl ?? FISH_API_BASE}/model`;
  const response = await postFishOnce({
    url,
    what: "voice clone",
    headers: fishHeaders(opts.apiKey),
    body: cloneForm(opts),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    consequence: VOICES_CHECK,
    fetch: opts.fetch,
  });
  // Fish accepted the upload, so the voice probably exists: an unreadable
  // answer is an unknown state (sending again could create a second voice).
  let raw: unknown;
  try {
    const bytes = await readCappedBytes(response, MAX_CLONE_ANSWER_BYTES, 60_000, url);
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw fishUnknownState("voice clone", `unreadable answer: ${reason}`, err, VOICES_CHECK);
  }
  const voice = parseFishVoice(raw);
  if (!voice) {
    throw fishUnknownState("voice clone", "the answer has no voice id", undefined, VOICES_CHECK);
  }
  return voice;
}
