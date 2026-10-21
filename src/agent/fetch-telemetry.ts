/**
 * Wraps globalThis.fetch for the CLI process (never in library or Worker
 * code): records each provider call (method, host, status, time) and the
 * usage its JSON response reports, and in --dry-run stops before the first
 * request leaves the machine. Bodies are read from a clone and only for
 * JSON responses under a size cap, so downloads are never buffered twice.
 */

import { extractUsage, hasUsage } from "../core/usage-extract.js";
import { run } from "./run-state.js";

const MAX_JSON_BYTES = 2_000_000;

export interface DryRunRequest {
  method: string;
  url: string;
  /** Top-level JSON body keys with values shortened; never header values. */
  body?: unknown;
  body_bytes?: number;
  headers?: string[];
}

/** Request URL without query string or fragment (signed URLs, keys). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function shorten(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") || value.length > 400) return `<${value.length} chars>`;
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((v) => shorten(v, depth + 1));
    return value.length > 10 ? [...items, `<+${value.length - 10} more>`] : items;
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "<object>";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        /key|token|secret|password|authorization/i.test(k) ? "[redacted]" : shorten(v, depth + 1),
      ]),
    );
  }
  return value;
}

function describeRequest(input: string | URL | Request, init?: RequestInit): DryRunRequest {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const out: DryRunRequest = { method, url: safeUrl(url) };
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const names = [...headers.keys()];
  if (names.length > 0) out.headers = names;
  const body = init?.body;
  if (typeof body === "string") {
    out.body_bytes = body.length;
    try {
      out.body = shorten(JSON.parse(body));
    } catch {
      out.body = `<${body.length} chars>`;
    }
  } else if (body instanceof FormData) {
    out.body = Object.fromEntries(
      [...body.entries()].map(([k, v]) => [
        k,
        typeof v === "string" ? shorten(v) : `<file ${v.size} bytes>`,
      ]),
    );
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    out.body_bytes = body.byteLength;
  }
  return out;
}

/**
 * Install the wrapper. `onDryRun` is called with the first request when the
 * run is a dry run; it must end the process (it never returns normally).
 */
export function installFetchTelemetry(onDryRun: (request: DryRunRequest) => never): void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (run.dryRun) onDryRun(describeRequest(input, init));
    const started = Date.now();
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let host = "";
    let path = "";
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
    } catch {}
    if (!run.requestModel) run.requestModel = modelFromRequest(path, init?.body);
    let response: Response;
    try {
      response = await original(input, init);
    } catch (error) {
      run.calls.push({ method, host, path, status: 0, ms: Date.now() - started });
      throw error;
    }
    run.calls.push({ method, host, path, status: response.status, ms: Date.now() - started });
    // Read in the background: the caller keeps its own size caps and stall detection.
    const pending = recordUsage(response, method, host, path).catch(() => {
      // Telemetry never breaks a command.
    });
    pendingReads.add(pending);
    void pending.finally(() => pendingReads.delete(pending));
    return response;
  }) as typeof fetch;
}

/**
 * The model a request names: a JSON body's `model`/`model_id`/`modelId`
 * (OpenAI, OpenRouter, BytePlus, MiniMax, Leonardo, ...) or a Gemini-style
 * `/models/<name>:method` path.
 */
export function modelFromRequest(path: string, body: unknown): string | undefined {
  const fromPath = path.match(/\/models\/([^/:]+):/)?.[1];
  if (fromPath) return decodeURIComponent(fromPath);
  if (typeof body !== "string" || body.length > 5_000_000) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["model", "model_id", "modelId", "version"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
    }
  } catch {}
  return undefined;
}

const pendingReads = new Set<Promise<void>>();

/** Wait (bounded) for background usage reads, so the summary includes them. */
export async function settleTelemetry(timeoutMs = 2_000): Promise<void> {
  if (pendingReads.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingReads]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** Read at most `limit` bytes of a clone; undefined (and the clone cancelled) past it. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function recordUsage(
  response: Response,
  method: string,
  host: string,
  path: string,
): Promise<void> {
  const type = response.headers.get("content-type") ?? "";
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  let body: unknown;
  if (response.ok && type.includes("json") && !(declared > MAX_JSON_BYTES)) {
    const text = await readCapped(response, MAX_JSON_BYTES);
    if (text !== undefined) {
      try {
        body = JSON.parse(text);
      } catch {}
    }
  }
  const usage = extractUsage(body, response.headers);
  for (const id of usage.ids) if (!run.ids.includes(id) && run.ids.length < 10) run.ids.push(id);
  if (!hasUsage(usage)) return;
  if (method === "GET") {
    // Polls repeat the job's running totals: keep the latest per endpoint family.
    run.getUsage.set(`${host}${path.replace(/[^/]{16,}/g, ":id")}`, usage);
  } else {
    run.postUsage.push(usage);
  }
}
