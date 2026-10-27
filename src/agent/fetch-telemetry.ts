/**
 * Wraps globalThis.fetch for the CLI process (never in library or Worker
 * code): records each provider call (method, host, status, time) and the
 * usage its JSON response reports, and in --dry-run stops before the first
 * request leaves the machine. Bodies are read from a clone and only for
 * JSON responses: whole under a size cap; above it (Gemini TTS returns its
 * audio inline as base64) only a rolling tail is kept, where the usage block
 * sits, so downloads are never buffered twice.
 */

import { extractUsage, hasUsage } from "../core/usage-extract.js";
import { preferRanked, run } from "./run-state.js";

const MAX_JSON_BYTES = 2_000_000;
/** Tail of an oversized JSON body searched for its trailing usage block. */
const TAIL_BYTES = 64_000;
/** Bodies larger than this are not scanned at all. */
const MAX_SCAN_BYTES = 200_000_000;

export interface DryRunRequest {
  method: string;
  url: string;
  /** Top-level JSON body keys with values shortened; never header values. */
  body?: unknown;
  body_bytes?: number;
  headers?: string[];
  /** Values of headers that select behaviour and carry no secret (Fish Audio's `model`). */
  header_values?: Record<string, string>;
}

/** Header values a dry run may show: they choose what runs and is billed, and hold no credential. */
const SHOWN_HEADER_VALUES = new Set(["model"]);

/** Request URL without query string or fragment (signed URLs, keys). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Query strings of http(s) URLs anywhere in a string (pre-signed URLs carry credentials). */
const URL_QUERY = /(https?:\/\/[^\s?#]*)\?[^\s#]*/gi;

function shorten(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") || value.length > 400) return `<${value.length} chars>`;
    return value.replace(URL_QUERY, "$1?[redacted]");
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
  const shown = names.filter((n) => SHOWN_HEADER_VALUES.has(n));
  if (shown.length > 0) {
    out.header_values = Object.fromEntries(
      shown.map((n) => [n, (headers.get(n) ?? "").slice(0, 100)]),
    );
  }
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
    const named = modelFromRequest(path, init?.body);
    if (!run.requestModel) run.requestModel = named;
    let response: Response;
    const seq = ++run.requestsStarted;
    try {
      response = await original(input, init);
    } catch (error) {
      run.calls.push({ method, host, path, status: 0, ms: Date.now() - started, seq });
      throw error;
    }
    run.calls.push({ method, host, path, status: response.status, ms: Date.now() - started, seq });
    // Read in the background: the caller keeps its own size caps and stall detection.
    const call = { method, host, path, seq, named: named ?? modelInPath(path) };
    const pending = recordUsage(response, call).catch(() => {
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
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ text?: string; tail?: string }> {
  const reader = response.clone().body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tail: Buffer | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SCAN_BYTES) {
      await reader.cancel();
      return {};
    }
    if (tail) {
      tail = Buffer.concat([tail, value]);
      if (tail.byteLength > TAIL_BYTES * 2) tail = tail.subarray(tail.byteLength - TAIL_BYTES);
      continue;
    }
    chunks.push(value);
    if (size > limit) {
      tail = Buffer.concat(chunks);
      tail = tail.subarray(Math.max(0, tail.byteLength - TAIL_BYTES));
      chunks.length = 0;
    }
  }
  if (tail) return { tail: tail.toString("utf8") };
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * The last top-level-looking `"usageMetadata": {...}` or `"usage": {...}` in a
 * JSON tail, parsed on its own. Strings in a usage block hold no braces, so
 * counting braces finds its end.
 */
export function usageFromTail(tail: string): Record<string, unknown> | undefined {
  for (const key of ["usageMetadata", "usage"]) {
    const at = tail.lastIndexOf(`"${key}"`);
    if (at < 0) continue;
    const open = tail.indexOf("{", at);
    if (open < 0 || !/^"\w+"\s*:\s*$/.test(tail.slice(at, open))) continue;
    let depth = 0;
    for (let i = open; i < tail.length; i++) {
      if (tail[i] === "{") depth++;
      else if (tail[i] === "}" && --depth === 0) {
        try {
          return { [key]: JSON.parse(tail.slice(open, i + 1)) };
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** Top-level response keys that name the model a provider served. */
const RESOLVED_MODEL_KEYS = ["model", "modelVersion", "model_version"];

/** The model a JSON response says it served, from its top-level keys only. */
export function modelFromResponse(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  for (const key of RESOLVED_MODEL_KEYS) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  }
  return undefined;
}

/** Gemini's trailing `"modelVersion": "..."` in the tail of an oversized body. */
export function modelFromTail(tail: string): string | undefined {
  const matches = [...tail.matchAll(/"modelVersion"\s*:\s*"([^"\\]{1,200})"/g)];
  return matches.at(-1)?.[1];
}

/**
 * The command's model (`--model` or a `<model>` argument) when the request path
 * carries it, as fal (`/fal-ai/flux/dev`) and Replicate
 * (`/models/<owner>/<name>/predictions`) submit a job: that request is the
 * generation request even though its body names no model.
 */
function modelInPath(path: string): string | undefined {
  const option = typeof run.options.model === "string" ? run.options.model : undefined;
  for (const model of [option, run.positionalModel]) {
    if (model?.includes("/") && path.includes(`/${model}`)) return model;
  }
  return undefined;
}

/** A Gemini long-running operation (`models/veo-…/operations/<id>`): the job id of a Veo run. */
function operationName(body: unknown): string | undefined {
  const name = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.length <= 200 && /(^|\/)operations\/[^/]+$/.test(name)
    ? name
    : undefined;
}

interface CallInfo {
  method: string;
  host: string;
  path: string;
  seq: number;
  /** Model the request named (body, path, or the command's model in the path): the generation request. */
  named?: string;
}

/**
 * Remember the served model and the job id this response reports. Only the
 * generation request (one that named a model) reports the served model, paired
 * with the model it asked for. For the job, that request outranks the rest, a
 * body id outranks a request-id header, and a GET (a poll or lookup) ranks last.
 */
function recordIdentity(
  call: CallInfo,
  body: unknown,
  model: string | undefined,
  ids: string[],
  headers: Headers,
): void {
  const base = call.named ? 0 : call.method === "GET" ? 4 : 2;
  if (model && call.named) {
    run.resolvedModel = preferRanked(run.resolvedModel, {
      seq: call.seq,
      rank: 0,
      model,
      requested: call.named,
    });
  }
  const headerIds = new Set<string>();
  headers.forEach((value, name) => {
    if (/(request|generation)-?id/i.test(name)) headerIds.add(value);
  });
  const fromBody = operationName(body) ?? ids.find((id) => !headerIds.has(id));
  const id = fromBody ?? ids[0];
  if (!id) return;
  run.job = preferRanked(run.job, {
    seq: call.seq,
    rank: base + (fromBody ? 0 : 1),
    id,
    method: call.method,
    host: call.host,
    path: call.path,
  });
}

async function recordUsage(response: Response, call: CallInfo): Promise<void> {
  const { method, host, path } = call;
  const type = response.headers.get("content-type") ?? "";
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  let body: unknown;
  let model: string | undefined;
  if (response.ok && type.includes("json") && !(declared > MAX_SCAN_BYTES)) {
    const { text, tail } = await readCapped(response, MAX_JSON_BYTES);
    if (text !== undefined) {
      try {
        body = JSON.parse(text);
      } catch {}
      model = modelFromResponse(body);
    } else if (tail !== undefined) {
      body = usageFromTail(tail);
      model = modelFromTail(tail);
    }
  }
  const usage = extractUsage(body, response.headers);
  for (const id of usage.ids) if (!run.ids.includes(id) && run.ids.length < 10) run.ids.push(id);
  if (response.ok) recordIdentity(call, body, model, usage.ids, response.headers);
  if (!hasUsage(usage)) return;
  if (usage.sources) {
    usage.sources = Object.fromEntries(
      Object.entries(usage.sources).map(([k, v]) => [k, `${host} ${v}`]),
    );
  }
  if (method === "GET") {
    // Polls repeat the job's running totals: keep the latest per endpoint family.
    run.getUsage.set(`${host}${path.replace(/[^/]{16,}/g, ":id")}`, usage);
  } else {
    run.postUsage.push(usage);
  }
}
