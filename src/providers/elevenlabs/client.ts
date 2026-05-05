/**
 * ElevenLabs API client — HTTP utilities shared by all elevenlabs commands.
 * Auth: ELEVENLABS_API_KEY → header "xi-api-key".
 */

import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { ELEVENLABS_BASE_URL } from "./models.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export function requireElevenLabsKey(): string {
  const key = resolveKey("ELEVENLABS_API_KEY");
  if (!key) {
    throw new ConfigError(
      "ELEVENLABS_API_KEY is not set. Get one at https://elevenlabs.io/app/settings/api-keys",
    );
  }
  return key;
}

function authHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return { "xi-api-key": apiKey, ...(extra ?? {}) };
}

/** GET JSON. */
export function apiGet<T>(
  endpoint: string,
  apiKey: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = new URL(`${ELEVENLABS_BASE_URL}/${endpoint.replace(/^\//, "")}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return httpJson<T>({ url: url.toString(), headers: authHeaders(apiKey) });
}

/** POST JSON. */
export function apiPostJson<T>(
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  opts: { timeoutMs?: number; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${ELEVENLABS_BASE_URL}/${endpoint.replace(/^\//, "")}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  return httpJson<T>({
    url: url.toString(),
    method: "POST",
    headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
    body: payload,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** DELETE. */
export async function apiDelete(endpoint: string, apiKey: string): Promise<void> {
  const url = `${ELEVENLABS_BASE_URL}/${endpoint.replace(/^\//, "")}`;
  const res = await globalThis.fetch(url, {
    method: "DELETE",
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, text.slice(0, 500), url);
  }
}

/**
 * POST and return raw bytes (audio/binary endpoints like TTS, SFX, Music, Isolation).
 */
export async function apiPostBinary(
  endpoint: string,
  body: Record<string, unknown> | FormData,
  apiKey: string,
  opts: { timeoutMs?: number; query?: Record<string, string> } = {},
): Promise<Buffer> {
  const url = new URL(`${ELEVENLABS_BASE_URL}/${endpoint.replace(/^\//, "")}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }

  const headers = authHeaders(apiKey);
  let init: RequestInit;
  if (body instanceof FormData) {
    init = {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
  } else {
    init = {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
  }

  let res: Response;
  try {
    res = await globalThis.fetch(url.toString(), init);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, url.toString());
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, text.slice(0, 500), url.toString());
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * POST multipart form data, parse JSON response.
 */
export async function apiPostMultipart<T>(
  endpoint: string,
  form: FormData,
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${ELEVENLABS_BASE_URL}/${endpoint.replace(/^\//, "")}`;
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, url);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, text.slice(0, 500), url);
  }
  return res.json() as Promise<T>;
}

/**
 * Read a local file as a web File for FormData. Throws ValidationError if missing.
 */
export function readFileAsBlob(filePath: string, fieldFilename?: string): File {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new ValidationError(`File not found: ${abs}`);
  const buf = fs.readFileSync(abs);
  const name = fieldFilename ?? path.basename(abs);
  return new File([new Uint8Array(buf)], name);
}

/**
 * Generic poller for ElevenLabs async endpoints (currently only Dubbing).
 * Calls statusFn until it returns a value with `status === "dubbed" | "complete"` or fails.
 */
export async function pollUntil<T extends { status?: string }>(
  fetchStatus: () => Promise<T>,
  isDone: (s: T) => boolean,
  isFailed: (s: T) => boolean,
  opts: { intervalMs?: number; timeoutMs?: number; logger?: Logger; label?: string } = {},
): Promise<T> {
  const { intervalMs = 5_000, timeoutMs = 600_000, logger, label = "task" } = opts;
  const deadline = Date.now() + timeoutMs;
  let elapsed = 0;
  while (Date.now() < deadline) {
    const cur = await fetchStatus();
    if (isDone(cur)) return cur;
    if (isFailed(cur)) {
      throw new ProviderError(`${label} failed: ${JSON.stringify(cur)}`, "elevenlabs");
    }
    if (elapsed > 0 && elapsed % 30_000 < intervalMs) {
      logger?.debug(`Polling ${label}... ${Math.round(elapsed / 1000)}s, status=${cur.status}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    elapsed += intervalMs;
  }
  throw new ProviderError(`${label} timed out after ${timeoutMs / 1000}s`, "elevenlabs");
}

/** Save bytes to multix-output dir with a standard filename + optional --output copy. */
export function saveBytes(opts: {
  bytes: Buffer;
  task: string;
  ext: string;
  outputCopy?: string;
  logger?: Logger;
}): string {
  const { bytes, task, ext, outputCopy, logger } = opts;
  const dir = getOutputDir();
  const dest = path.join(dir, `elevenlabs_${task}_${Date.now()}.${ext}`);
  fs.writeFileSync(dest, bytes);
  logger?.success(`Saved: ${dest} (${(bytes.length / 1024).toFixed(1)} KB)`);
  if (outputCopy) {
    fs.mkdirSync(path.dirname(path.resolve(outputCopy)), { recursive: true });
    fs.copyFileSync(dest, outputCopy);
  }
  return dest;
}
