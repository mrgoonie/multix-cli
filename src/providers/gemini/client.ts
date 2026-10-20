/**
 * GeminiClient — thin REST wrapper around Gemini generateContent + Files API.
 * Uses fetchJson from core (global fetch). No google-genai SDK dependency.
 *
 * Runtime-neutral: no node:* imports and no env, key-pool or disk access, so a
 * Cloudflare Worker can reuse it. Callers pass `apiKey`; the CLI picks it from
 * the rotation pool (key-pool.ts) and keeps one key across a multi-step flow
 * (an uploaded file only exists for the key that uploaded it). Local files
 * are handled by local-files.ts.
 *
 * Auth: x-goog-api-key header (preferred over ?key= query param).
 * Base: https://generativelanguage.googleapis.com
 */

import { HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { isNetworkFetchFailure, toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { FILES_API_MAX_BYTES } from "../../core/limits.js";
import type { Logger } from "../../core/logger.js";
import { requiresProcessingWait } from "./media-types.js";

const API_HOST = "generativelanguage.googleapis.com";
const BASE = `https://${API_HOST}`;
const FILES_BASE = `${BASE}/upload/v1beta/files`;
const GENERATE_BASE = `${BASE}/v1beta/models`;

/** Uploaded file reference returned by Files API. */
export interface FileRef {
  name: string;
  uri: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED";
  mimeType: string;
}

/** Part of a generateContent request. */
export type ContentPart =
  | { text: string }
  | { fileData: { mimeType: string; fileUri: string } }
  | { inlineData: { mimeType: string; data: string } };

export interface GenerateContentRequest {
  model: string;
  contents: Array<{ role?: string; parts: ContentPart[] }>;
  generationConfig?: Record<string, unknown>;
}

export interface GenerateContentResponse {
  candidates?: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
}

export interface ImageGenerationResponse {
  images?: Array<{ imageBytes: string; mimeType: string }>;
}

export interface GeminiCallOptions {
  /** Gemini API key; the CLI picks it from the rotation pool (`withGeminiKey`). */
  apiKey: string;
  logger?: Logger;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

export { FILES_API_MAX_BYTES };

const DEFAULT_TIMEOUT_MS = 300_000;
/** Default slowest sustained upload speed the upload timeout allows for (1 MB/s, about 8 Mbit/s). */
export const DEFAULT_MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;
/** Fixed allowance on top of the transfer time (connection setup, server finalize). */
const UPLOAD_TIMEOUT_SLACK_MS = 60_000;

/**
 * Timeout for sending the file bytes: never below `timeoutMs`, and long enough
 * for the whole file at `bytesPerSec` (default 1 MB/s) plus 60 s, so a 2 GB
 * file gets about 35 minutes. Processing (the ACTIVE poll) keeps its own
 * `timeoutMs` deadline.
 */
export function uploadTimeoutMs(
  size: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  bytesPerSec = DEFAULT_MIN_UPLOAD_BYTES_PER_SEC,
): number {
  return Math.max(timeoutMs, UPLOAD_TIMEOUT_SLACK_MS + Math.ceil((size / bytesPerSec) * 1000));
}

/** Bytes and metadata for a Files API upload. */
export interface UploadSource {
  /**
   * The bytes to send. A file-backed Blob (Node's `fs.openAsBlob`) is streamed
   * from disk in small chunks; a Worker can pass its own Blob or File. Its
   * `type` is ignored: `mimeType` is what the Files API stores.
   */
  blob: Blob;
  /** File name stored with the upload and shown in messages. */
  displayName: string;
  mimeType: string;
  /** Name used in processing errors (e.g. the local path); defaults to `displayName`. */
  label?: string;
}

/**
 * Upload a Blob to the Gemini Files API with the resumable protocol
 * (start a session, then send the bytes in one `upload, finalize` request).
 * The Blob is streamed (never copied whole into memory); Blobs above the
 * 2 GB Files API limit are rejected before any request is made.
 * Polls until ACTIVE for audio/video files.
 */
export async function uploadFile(
  source: UploadSource,
  opts: GeminiCallOptions & {
    timeoutMs?: number;
    /** Slowest upload speed to allow for, in bytes per second (default 1 MB/s). */
    minUploadBytesPerSec?: number;
  },
): Promise<FileRef> {
  const size = source.blob.size;
  if (size > FILES_API_MAX_BYTES) {
    throw new ValidationError(
      `File too large for the Gemini Files API: ${source.displayName} is ${formatMb(size)} MB (limit 2 GB = ${FILES_API_MAX_BYTES} bytes)`,
    );
  }
  const { apiKey, minUploadBytesPerSec = DEFAULT_MIN_UPLOAD_BYTES_PER_SEC } = opts;
  return uploadFileWithKey(source, apiKey, { ...opts, bytesPerSec: minUploadBytesPerSec });
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * fetch for the upload steps. Errors name FILES_BASE, never the session upload
 * URL, which grants write access to the upload on its own.
 *
 * - Non-OK response: HttpError with its status (quota failures rotate keys).
 * - Network failure (connection reset, DNS, a timed-out `start` request):
 *   HttpError with status 0, which callers such as `doc convert` treat as
 *   transient and retry.
 * - Refused redirect or a timed-out byte upload: ProviderError, never retried,
 *   so a deterministic failure or a slow multi-GB upload is not sent again.
 * - A deterministic rejection (invalid header value or URL, TLS certificate
 *   error): ConfigError or ProviderError from `toFetchError`, never retried.
 * Transport errors keep the original error as `cause`.
 */
async function uploadFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  step: "start" | "upload",
): Promise<Response> {
  let resp: Response;
  try {
    resp = await globalThis.fetch(url, {
      ...init,
      // With the default "follow", fetch clones the request body (tee) to replay
      // it on a redirect, and that copy keeps every chunk in memory.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    const timedOut = e?.name === "TimeoutError";
    const redirected = e?.cause instanceof Error && e.cause.message === "unexpected redirect";
    const reason = timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)} s`
      : e?.cause instanceof Error
        ? `${e.message}: ${e.cause.message}`
        : String(e?.message ?? err);
    const message = `File upload failed: ${reason}`;
    if (redirected || (timedOut && step === "upload")) {
      throw new ProviderError(message, "gemini", { cause: err });
    }
    if (!isNetworkFetchFailure(err)) {
      throw toFetchError(err, FILES_BASE, {
        provider: "gemini",
        prefix: "File upload failed: ",
        target: step === "start" ? FILES_BASE : "the upload session URL",
      });
    }
    throw new HttpError(0, message, FILES_BASE, undefined, { cause: err });
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new HttpError(resp.status, `File upload failed: ${txt.slice(0, 500)}`, FILES_BASE);
  }
  return resp;
}

/**
 * Read the `upload, finalize` response. The upload only counts when the server
 * reports `X-Goog-Upload-Status: final` and returns a file with a name and URI;
 * anything else fails here instead of as an undefined fileUri later. The
 * message never includes the response body or the session URL.
 */
async function readFinalizedFile(resp: Response): Promise<FileRef> {
  const status = resp.headers.get("x-goog-upload-status")?.trim().toLowerCase();
  let file: Partial<FileRef> | undefined;
  let readError: unknown;
  try {
    file = ((await resp.json()) as { file?: Partial<FileRef> } | null)?.file;
  } catch (err) {
    readError = err;
  }
  if (status !== "final" || typeof file?.uri !== "string" || typeof file?.name !== "string") {
    const detail =
      status !== "final"
        ? `upload status is "${status?.slice(0, 40) ?? "missing"}"`
        : readError
          ? "unreadable response body"
          : "no file in the response";
    throw new ProviderError(`File upload failed: upload was not finalized (${detail})`, "gemini", {
      cause: readError,
    });
  }
  return file as FileRef;
}

function unwrapFile(resp: FileRef | { file: FileRef }): FileRef {
  const file =
    resp && typeof resp === "object" && "file" in resp && resp.file ? resp.file : (resp as FileRef);
  if (typeof file?.state !== "string") {
    throw new ProviderError("File processing check returned no file state", "gemini");
  }
  return file;
}

async function uploadFileWithKey(
  source: UploadSource,
  apiKey: string,
  opts: { timeoutMs?: number; logger?: Logger; bytesPerSec: number },
): Promise<FileRef> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, logger, bytesPerSec } = opts;

  const { mimeType, displayName, label = source.displayName } = source;
  // fetch streams the Blob while sending and derives Content-Length from its size.
  // A typed Blob would also add a Content-Type header, so drop the type to send
  // the same request for every caller (slice keeps a file-backed Blob lazy).
  const file = source.blob.type ? source.blob.slice(0, source.blob.size, "") : source.blob;

  logger?.debug(`Uploading ${displayName} (${formatMb(file.size)} MB)`);

  // Step 1: open a resumable session; the upload URL comes back in a header.
  const start = await uploadFetch(
    FILES_BASE,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
    timeoutMs,
    "start",
  );
  const uploadUrl = start.headers.get("x-goog-upload-url");
  await start.body?.cancel();
  if (!uploadUrl) {
    throw new ProviderError("File upload failed: the Files API returned no upload URL", "gemini");
  }

  // Step 2: send the bare file bytes and finalize in the same request.
  const resp = await uploadFetch(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: file,
    },
    uploadTimeoutMs(file.size, timeoutMs, bytesPerSec),
    "upload",
  );

  let fileRef = await readFinalizedFile(resp);

  // Poll for audio/video processing
  if (requiresProcessingWait(mimeType)) {
    const deadline = Date.now() + timeoutMs;
    while (fileRef.state === "PROCESSING" && Date.now() < deadline) {
      await sleep(2000);
      // files.get returns the File itself; only the upload response wraps it in `file`.
      fileRef = unwrapFile(
        await fetchJson<FileRef | { file: FileRef }>({
          url: `${BASE}/v1beta/${fileRef.name}`,
          headers: authHeaders(apiKey),
        }),
      );
      logger?.debug(`Processing... state=${fileRef.state}`);
    }
    if (fileRef.state === "FAILED")
      throw new ProviderError(`File processing failed: ${label}`, "gemini");
    if (fileRef.state === "PROCESSING")
      throw new ProviderError(`Processing timeout: ${label}`, "gemini");
  }

  logger?.debug(`Uploaded: ${fileRef.name} (${fileRef.uri})`);
  return fileRef;
}

/**
 * Call generateContent endpoint and return the full response.
 */
export async function generateContent(
  req: GenerateContentRequest,
  opts: GeminiCallOptions,
): Promise<GenerateContentResponse> {
  return fetchJson<GenerateContentResponse>({
    url: `${GENERATE_BASE}/${req.model}:generateContent`,
    method: "POST",
    headers: authHeaders(opts.apiKey),
    body: {
      contents: req.contents,
      ...(req.generationConfig ? { generationConfig: req.generationConfig } : {}),
    },
  });
}

/**
 * Call the Interactions endpoint (POST /v1beta/interactions) and return the raw
 * Interaction resource. Gemini 3.8 TTS models are served here, not on generateContent.
 */
export async function createInteraction(
  body: Record<string, unknown>,
  opts: GeminiCallOptions & { timeoutMs?: number; fetch?: FetchLike },
): Promise<unknown> {
  return fetchJson<unknown>({
    url: `${BASE}/v1beta/interactions`,
    method: "POST",
    headers: authHeaders(opts.apiKey),
    body,
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
  });
}

/** Interaction ids are opaque URL-safe tokens (e.g. `v1_Chdl…`); anything else never reaches a URL. */
const INTERACTION_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function assertInteractionId(id: string): string {
  const trimmed = id.trim();
  if (!INTERACTION_ID_RE.test(trimmed)) {
    throw new ValidationError(`Invalid interaction id: ${trimmed.slice(0, 80)}`);
  }
  return trimmed;
}

/** GET /v1beta/interactions/{id}: the stored Interaction resource (status, steps, usage). */
export async function getInteraction(
  id: string,
  opts: GeminiCallOptions & { timeoutMs?: number; fetch?: FetchLike },
): Promise<unknown> {
  return fetchJson<unknown>({
    url: `${BASE}/v1beta/interactions/${assertInteractionId(id)}`,
    headers: authHeaders(opts.apiKey),
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
  });
}

/** POST /v1beta/interactions/{id}/cancel: stops a background interaction that is still running. */
export async function cancelInteraction(
  id: string,
  opts: GeminiCallOptions & { fetch?: FetchLike },
): Promise<unknown> {
  return fetchJson<unknown>({
    url: `${BASE}/v1beta/interactions/${assertInteractionId(id)}/cancel`,
    method: "POST",
    headers: authHeaders(opts.apiKey),
    body: {},
    fetch: opts.fetch,
  });
}

/** Files API resource name (`files/<id>`) accepted by getFile and fileDownloadUrl. */
const FILE_NAME_RE = /^files\/[A-Za-z0-9_-]{1,256}$/;

/** GET /v1beta/files/{id}: metadata including `state` (PROCESSING, ACTIVE, FAILED). */
export async function getFile(
  name: string,
  opts: GeminiCallOptions & { timeoutMs?: number; fetch?: FetchLike },
): Promise<FileRef & { sizeBytes?: string }> {
  if (!FILE_NAME_RE.test(name)) throw new ValidationError(`Invalid Gemini file name: ${name}`);
  return fetchJson<FileRef & { sizeBytes?: string }>({
    url: `${BASE}/v1beta/${name}`,
    headers: authHeaders(opts.apiKey),
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
  });
}

/** Media download URL for a Files API resource; it needs the x-goog-api-key header. */
export function fileDownloadUrl(name: string): string {
  if (!FILE_NAME_RE.test(name)) throw new ValidationError(`Invalid Gemini file name: ${name}`);
  return `${BASE}/v1beta/${name}:download?alt=media`;
}

/**
 * The Files API resource name behind a Gemini API file URI, or null when the
 * URI points anywhere else (another host, plain http, an unexpected path).
 * Only such URIs may receive the API key.
 */
export function geminiFileNameFromUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.host !== API_HOST) return null;
  const match = /^\/v1beta\/(files\/[A-Za-z0-9_-]{1,256})(?::download)?$/.exec(parsed.pathname);
  return match?.[1] ?? null;
}

/**
 * Extract the last audio content block from an Interaction resource.
 * Audio blocks ({ type: "audio", data, mime_type }) are nested inside the
 * interaction steps; the SDK's `output_audio` is the last one, so we match that.
 */
export function extractInteractionAudio(resp: unknown): { mimeType: string; data: string } | null {
  let found: { mimeType: string; data: string } | null = null;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.type === "audio" && typeof o.data === "string") {
      const mime = (o.mime_type ?? o.mimeType ?? "audio/wav") as string;
      found = { mimeType: mime, data: o.data };
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(resp);
  return found;
}

/**
 * Extract text from a generateContent response.
 */
export function extractText(resp: GenerateContentResponse): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.text !== undefined)
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * Extract inline audio data from a generateContent response.
 * Returns first audio part as { mimeType, data } (base64), or null.
 * TTS models emit audio/L16 (PCM s16le) at the rate declared in mimeType.
 */
export function extractAudio(
  resp: GenerateContentResponse,
): { mimeType: string; data: string } | null {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.inlineData?.mimeType.startsWith("audio/")) {
      return { mimeType: p.inlineData.mimeType, data: p.inlineData.data };
    }
  }
  return null;
}

/**
 * Extract inline image data from a generateContent response.
 * Returns array of { mimeType, data } (base64).
 */
export function extractImages(
  resp: GenerateContentResponse,
): Array<{ mimeType: string; data: string }> {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter(
      (p): p is { inlineData: { mimeType: string; data: string } } => p.inlineData !== undefined,
    )
    .map((p) => ({ mimeType: p.inlineData.mimeType, data: p.inlineData.data }));
}

/**
 * List available Gemini models — used for connectivity check.
 */
export async function listModels(opts: { apiKey: string; timeoutMs?: number }): Promise<string[]> {
  const { apiKey, timeoutMs = 10_000 } = opts;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  const resp = await fetchJson<any>({
    url: `${BASE}/v1beta/models`,
    headers: authHeaders(apiKey),
    timeoutMs,
  });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  return ((resp.models ?? []) as any[]).map((m: any) => m.name as string);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
