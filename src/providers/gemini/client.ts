/**
 * GeminiClient — thin REST wrapper around Gemini generateContent + Files API.
 * Uses httpJson from core (undici fetch). No google-genai SDK dependency.
 *
 * Auth: x-goog-api-key header (preferred over ?key= query param). Keys come
 * from the rotation pool in key-pool.ts; pass `apiKey` to pin one key across a
 * multi-step flow (an uploaded file only exists for the key that uploaded it).
 * Base: https://generativelanguage.googleapis.com
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { downloadFile, httpJson } from "../../core/http-client.js";
import { FILES_API_MAX_BYTES } from "../../core/limits.js";
import type { Logger } from "../../core/logger.js";
import { withGeminiKey } from "./key-pool.js";
import { requiresProcessingWait } from "./task-resolver.js";

const BASE = "https://generativelanguage.googleapis.com";
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
  /** Use this key instead of picking one from the rotation pool. */
  apiKey?: string;
  logger?: Logger;
}

/** Run with the pinned key, or with key rotation when none was given. */
function withKey<T>(opts: GeminiCallOptions, fn: (apiKey: string) => Promise<T>): Promise<T> {
  return opts.apiKey ? fn(opts.apiKey) : withGeminiKey(fn, { logger: opts.logger });
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

export { FILES_API_MAX_BYTES };

const DEFAULT_TIMEOUT_MS = 300_000;
export const UPLOAD_MIN_KBPS_ENV = "MULTIX_UPLOAD_MIN_KBPS";
/** Default slowest sustained upload speed the upload timeout allows for (1 MB/s, about 8 Mbit/s). */
const DEFAULT_MIN_UPLOAD_BYTES_PER_SEC = 1_000_000;
/** Fixed allowance on top of the transfer time (connection setup, server finalize). */
const UPLOAD_TIMEOUT_SLACK_MS = 60_000;

/**
 * Slowest upload speed to allow for, in bytes per second: MULTIX_UPLOAD_MIN_KBPS
 * (kilobytes of 1,000 bytes per second), default 1000 (1 MB/s).
 */
export function minUploadBytesPerSec(): number {
  const raw = resolveKey(UPLOAD_MIN_KBPS_ENV)?.trim();
  if (!raw) return DEFAULT_MIN_UPLOAD_BYTES_PER_SEC;
  const kbps = Number(raw);
  if (!Number.isFinite(kbps) || kbps < 1) {
    throw new ConfigError(
      `${UPLOAD_MIN_KBPS_ENV} must be a number of kilobytes per second, at least 1, got "${raw}"`,
    );
  }
  return kbps * 1000;
}

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
   * from disk in small chunks; a Worker can pass its own Blob or File.
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
  opts: GeminiCallOptions & { timeoutMs?: number } = {},
): Promise<FileRef> {
  const size = source.blob.size;
  if (size > FILES_API_MAX_BYTES) {
    throw new ValidationError(
      `File too large for the Gemini Files API: ${source.displayName} is ${formatMb(size)} MB (limit 2 GB = ${FILES_API_MAX_BYTES} bytes)`,
    );
  }
  // Read before any request so a bad value fails fast and is never retried.
  const bytesPerSec = minUploadBytesPerSec();
  return withKey(opts, (apiKey) => uploadFileWithKey(source, apiKey, { ...opts, bytesPerSec }));
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

async function uploadFileWithKey(
  source: UploadSource,
  apiKey: string,
  opts: { timeoutMs?: number; logger?: Logger; bytesPerSec: number },
): Promise<FileRef> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, logger, bytesPerSec } = opts;

  const { mimeType, displayName, label = source.displayName } = source;
  // fetch streams the Blob while sending and derives Content-Length from its size.
  const file = source.blob;

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
      fileRef = await httpJson<{ file: FileRef }>({
        url: `${BASE}/v1beta/${fileRef.name}`,
        headers: authHeaders(apiKey),
      }).then((r) => r.file);
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
  opts: GeminiCallOptions = {},
): Promise<GenerateContentResponse> {
  return withKey(opts, (apiKey) =>
    httpJson<GenerateContentResponse>({
      url: `${GENERATE_BASE}/${req.model}:generateContent`,
      method: "POST",
      headers: authHeaders(apiKey),
      body: {
        contents: req.contents,
        ...(req.generationConfig ? { generationConfig: req.generationConfig } : {}),
      },
    }),
  );
}

/**
 * Call the Interactions endpoint (POST /v1beta/interactions) and return the raw
 * Interaction resource. Gemini 3.8 TTS models are served here, not on generateContent.
 */
export async function createInteraction(
  body: Record<string, unknown>,
  opts: GeminiCallOptions = {},
): Promise<unknown> {
  return withKey(opts, (apiKey) =>
    httpJson<unknown>({
      url: `${BASE}/v1beta/interactions`,
      method: "POST",
      headers: authHeaders(apiKey),
      body,
    }),
  );
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
export async function listModels(timeoutMs = 10_000): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  const resp = await withGeminiKey<any>((apiKey) =>
    httpJson({ url: `${BASE}/v1beta/models`, headers: authHeaders(apiKey), timeoutMs }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  return ((resp.models ?? []) as any[]).map((m: any) => m.name as string);
}

/**
 * Download a generated video from the Files API to a local path.
 */
export async function downloadGeneratedFile(fileUri: string, dest: string): Promise<void> {
  await downloadFile(fileUri, dest);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
