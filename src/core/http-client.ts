/**
 * HTTP utilities for multix CLI providers.
 * Uses Node 20+ globalThis.fetch so tests can mock it via globalThis.fetch assignment.
 * downloadFile streams to disk without buffering the full body.
 */

import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const SNIPPET_MAX = 500;

export interface HttpJsonOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: generic JSON body
  body?: Record<string, unknown> | unknown[] | any;
  timeoutMs?: number;
}

/**
 * Make an HTTP request and parse the JSON response.
 * Throws HttpError on non-2xx status.
 */
export async function httpJson<T>(opts: HttpJsonOptions): Promise<T> {
  const { url, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await globalThis.fetch(url, init);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, url);
  }

  if (!response.ok) {
    let snippet = "";
    try {
      const text = await response.text();
      snippet = text.slice(0, SNIPPET_MAX);
    } catch {
      snippet = "(could not read body)";
    }
    throw new HttpError(response.status, snippet, url);
  }

  return response.json() as Promise<T>;
}

/**
 * Download a URL to a local file path, streaming to avoid large memory usage.
 * Parent directory is created if it does not exist.
 */
export async function downloadFile(url: string, dest: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let response: Response;
  try {
    response = await globalThis.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, url);
  }

  if (!response.ok) {
    throw new HttpError(response.status, "(download failed)", url);
  }

  if (!response.body) {
    throw new HttpError(0, "Response body is null", url);
  }

  const fileStream = fs.createWriteStream(dest);
  // response.body is a web ReadableStream; Node's pipeline accepts it
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
}

/**
 * Decode a data: URI or download an http(s) URL, returning raw bytes.
 */
export async function fetchBytes(urlOrDataUri: string): Promise<Buffer> {
  if (urlOrDataUri.startsWith("data:")) {
    const commaIdx = urlOrDataUri.indexOf(",");
    if (commaIdx === -1) throw new Error("Malformed data URI: missing comma");
    const encoded = urlOrDataUri.slice(commaIdx + 1);
    return Buffer.from(encoded, "base64");
  }

  let response: Response;
  try {
    response = await globalThis.fetch(urlOrDataUri, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(0, msg, urlOrDataUri);
  }

  if (!response.ok) {
    throw new HttpError(response.status, "(bytes fetch failed)", urlOrDataUri);
  }

  return Buffer.from(await response.arrayBuffer());
}
