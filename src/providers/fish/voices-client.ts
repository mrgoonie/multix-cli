/**
 * Fish Audio voice models (runtime-neutral: no `node:*` imports; the caller
 * passes the key, `fetch` and sample bytes). GET /model lists voice models,
 * your own with `self=true`; GET /model/{id} reads one. POST /model clones a
 * voice from 1 to 20 samples (multipart), PATCH /model/{id} edits its metadata
 * and DELETE /model/{id} removes it. The create POST is never retried: a second
 * request creates a second model.
 * Docs: https://docs.fish.audio/api-reference/endpoint/model/get-model
 */

import { HttpError, MultixError, ProviderError } from "../../core/errors.js";
import { type FetchLike, fetchJson, parseRetryAfter } from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import { UNKNOWN_REMOTE_STATE, readCappedText } from "../../core/response-read.js";
import { FISH_API_BASE } from "./models.js";
import {
  fishErrorMessage,
  fishFetchFailure,
  fishHeaders,
  fishUnknownState,
  isFishError,
} from "./tts-client.js";

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

export const FISH_MAX_VOICE_SAMPLES = 20;
/** Visibility a new or edited model may get; `public` on create is downgraded to private by Fish. */
export const FISH_VISIBILITIES = ["private", "unlist", "public"] as const;
export type FishVisibility = (typeof FISH_VISIBILITIES)[number];

export interface FishVoiceSample {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface CreateFishVoiceOptions {
  apiKey: string;
  title: string;
  samples: FishVoiceSample[];
  /** One transcript per sample, in order; omitted means Fish runs ASR. */
  texts?: string[];
  description?: string;
  tags?: string[];
  visibility?: Exclude<FishVisibility, "public">;
  enhanceAudioQuality?: boolean;
  generateSample?: boolean;
  /** One /v1/voice-design signature per sample, in order. */
  voiceDesignSignatures?: string[];
  /** Whole request, upload included. Default 300 s. */
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: FetchLike;
}

/**
 * Clone a voice (POST /model, train_mode fast). Errors: HttpError for Fish's
 * own non-2xx answer, ProviderError for a 2xx answer without a model id, and
 * UNKNOWN_REMOTE_STATE when the connection broke after Fish may have created
 * the model.
 */
export async function createFishVoice(opts: CreateFishVoiceOptions): Promise<FishVoice> {
  const form = new FormData();
  form.append("type", "tts");
  form.append("train_mode", "fast");
  form.append("title", opts.title);
  form.append("visibility", opts.visibility ?? "private");
  if (opts.description) form.append("description", opts.description);
  for (const tag of opts.tags ?? []) form.append("tags", tag);
  for (const sample of opts.samples) {
    form.append("voices", new Blob([sample.bytes], { type: sample.mime }), sample.name);
  }
  for (const text of opts.texts ?? []) form.append("texts", text);
  for (const sig of opts.voiceDesignSignatures ?? []) form.append("voice_design_signatures", sig);
  if (opts.enhanceAudioQuality !== undefined) {
    form.append("enhance_audio_quality", String(opts.enhanceAudioQuality));
  }
  if (opts.generateSample !== undefined)
    form.append("generate_sample", String(opts.generateSample));

  const url = `${opts.baseUrl ?? FISH_API_BASE}/model`;
  const what = "voice clone";
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      url,
      {
        method: "POST",
        headers: fishHeaders(opts.apiKey),
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    throw unknownModel(fishFetchFailure(cause, url, what));
  }
  let text: string;
  try {
    text = await readCappedText(response, 4 * 1024 * 1024);
  } catch (cause) {
    throw unknownModel(fishUnknownState(what, "response body failed", cause));
  }
  if (!response.ok) {
    if (response.status >= 500 && !isFishError(text)) {
      throw unknownModel(fishUnknownState(what, `HTTP ${response.status} from the gateway`));
    }
    throw new HttpError(
      response.status,
      fishErrorMessage(text),
      url,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unknownModel(fishUnknownState(what, "the response is not complete JSON"));
  }
  const voice = parseFishVoice(parsed);
  if (!voice) {
    throw unknownModel(
      new ProviderError("Fish Audio answered the voice clone without a model id", "fish"),
    );
  }
  return voice;
}

/** Point an unclear create outcome at the list, so nobody clones twice blind. */
function unknownModel(err: Error): Error {
  const unclear =
    err instanceof ProviderError ||
    (err instanceof MultixError && err.code === UNKNOWN_REMOTE_STATE);
  if (!unclear) return err;
  err.message +=
    " It may have created a voice model: check `multix fish voices list` before creating it again.";
  return err;
}

export interface UpdateFishVoiceOptions {
  apiKey: string;
  id: string;
  title?: string;
  description?: string;
  visibility?: FishVisibility;
  tags?: string[];
  baseUrl?: string;
  fetch?: FetchLike;
}

/** Edit a voice model's metadata (PATCH /model/{id}); returns the model as Fish now reports it. */
export async function updateFishVoice(opts: UpdateFishVoiceOptions): Promise<FishVoice> {
  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (opts.tags !== undefined) body.tags = opts.tags;
  await fetchJson<unknown>({
    url: `${opts.baseUrl ?? FISH_API_BASE}/model/${encodeURIComponent(opts.id)}`,
    method: "PATCH",
    headers: fishHeaders(opts.apiKey),
    body,
    timeoutMs: 60_000,
    maxBytes: 4 * 1024 * 1024,
    fetch: opts.fetch,
  });
  // The 200 has no documented body; read the model back for its current state.
  return getFishVoice(opts);
}

/** Delete a voice model (DELETE /model/{id}). */
export async function deleteFishVoice(opts: {
  apiKey: string;
  id: string;
  baseUrl?: string;
  fetch?: FetchLike;
}): Promise<void> {
  await fetchJson<unknown>({
    url: `${opts.baseUrl ?? FISH_API_BASE}/model/${encodeURIComponent(opts.id)}`,
    method: "DELETE",
    headers: fishHeaders(opts.apiKey),
    timeoutMs: 60_000,
    maxBytes: 1024 * 1024,
    fetch: opts.fetch,
  });
}
