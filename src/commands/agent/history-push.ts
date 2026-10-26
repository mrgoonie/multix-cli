/**
 * `multix history push`: opt-in upload of the local run ledger to the usage
 * ledger of a multix account (POST {base}/api/v1/usage/import). Only
 * measurements leave the machine: ids, timings, command and model names,
 * outcome and error code, output sizes and hashes, provider usage and HTTP
 * counts. Prompts, argv, cwd, error messages, output paths and media never do.
 * The server deduplicates on the history id, so pushing twice is harmless.
 */

import type { HistoryEntry } from "../../agent/history-store.js";
import { ConfigError, HttpError, ProviderError } from "../../core/errors.js";
import { type FetchLike, fetchJson } from "../../core/fetch-json.js";
import { redactUrl } from "../../core/redact.js";
import { isLoopbackHost } from "../../core/url-safety.js";

export const REMOTE_URL_ENV = "MULTIX_REMOTE_URL";
export const API_KEY_ENV = "MULTIX_API_KEY";
export const DEFAULT_REMOTE_URL = "https://multix.zuey.me";
export const IMPORT_PATH = "/api/v1/usage/import";
/** Entries per request; the server refuses larger batches. */
export const PUSH_BATCH_SIZE = 200;
const PUSH_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_IDS = 10;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

export interface ImportEntry {
  id: string;
  ts: string;
  duration_ms: number;
  command: string;
  provider: string;
  model?: string;
  ok: boolean;
  exit_code: number;
  error_code?: string;
  outputs?: { bytes: number; mime?: string; sha256?: string; duration_s?: number }[];
  usage?: {
    tokens?: { input?: number; output?: number; total?: number; thinking?: number };
    cost_usd?: number;
    credits?: number;
    metrics?: Record<string, number>;
  };
  http?: { requests: number; errors: number; ms: number };
  provider_ids?: string[];
  version?: string;
}

export interface PushSummary {
  accepted: number;
  duplicates: number;
  rejected: number;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Anything that carries a scheme (http://, s3://, data:…) or an absolute path. */
const URL_LIKE = /:\/\/|^[a-z][a-z0-9+.-]*:[^\s]*\/|^data:|^[/\\~]|^[a-z]:[\\/]/i;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** A short identifier-like string, or undefined (drops URLs, paths and long text). */
function name(v: unknown, max = MAX_NAME_LENGTH): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= max && !URL_LIKE.test(s) && !/\s/.test(s) ? s : undefined;
}

/** Copy only the keys whose value is defined. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function importUsage(usage: HistoryEntry["usage"]): ImportEntry["usage"] {
  if (!usage) return undefined;
  const t = usage.tokens;
  const tokens = t
    ? compact({
        input: num(t.input),
        output: num(t.output),
        total: num(t.total),
        thinking: num(t.thinking),
      })
    : undefined;
  const metrics = usage.metrics
    ? Object.fromEntries(
        Object.entries(usage.metrics).filter(
          ([k, v]) => num(v) !== undefined && k.length <= MAX_NAME_LENGTH && !URL_LIKE.test(k),
        ),
      )
    : undefined;
  const out = compact({
    tokens: tokens && Object.keys(tokens).length ? tokens : undefined,
    cost_usd: num(usage.cost_usd),
    credits: num(usage.credits),
    metrics: metrics && Object.keys(metrics).length ? metrics : undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

/**
 * Map one ledger entry to what the server stores, dropping everything that
 * could hold a prompt, a path or a secret: argv, cwd, the error message and
 * output paths are never copied; strings that look like URLs or paths are
 * dropped; sha256 is kept only as 64 hex digits; at most 10 provider ids.
 */
export function toImportEntry(entry: HistoryEntry): ImportEntry {
  const outputs = (entry.outputs ?? []).flatMap((o) => {
    const bytes = num(o.bytes);
    if (bytes === undefined) return [];
    return [
      compact({
        bytes,
        mime: typeof o.mime === "string" && MIME.test(o.mime) ? o.mime.toLowerCase() : undefined,
        sha256:
          typeof o.sha256 === "string" && SHA256.test(o.sha256)
            ? o.sha256.toLowerCase()
            : undefined,
        duration_s: num(o.duration_s),
      }),
    ];
  });
  const providerIds = (entry.provider_ids ?? [])
    .map((id) => name(id, MAX_PROVIDER_ID_LENGTH))
    .filter((id): id is string => id !== undefined)
    .slice(0, MAX_PROVIDER_IDS);
  const http = entry.http;
  const errorCode = entry.error?.code;
  return compact({
    id: entry.id,
    ts: entry.ts,
    duration_ms: num(entry.duration_ms) ?? 0,
    command: entry.command,
    provider: entry.provider,
    model: name(entry.model),
    ok: entry.ok,
    exit_code: num(entry.exit_code) ?? (entry.ok ? 0 : 1),
    error_code: typeof errorCode === "string" && ERROR_CODE.test(errorCode) ? errorCode : undefined,
    outputs: outputs.length ? outputs : undefined,
    usage: importUsage(entry.usage),
    http:
      http &&
      num(http.requests) !== undefined &&
      num(http.errors) !== undefined &&
      num(http.ms) !== undefined
        ? { requests: http.requests, errors: http.errors, ms: http.ms }
        : undefined,
    provider_ids: providerIds.length ? providerIds : undefined,
    version: name(entry.version, 64),
  });
}

/** Runs worth importing: real runs (not dry runs) with the fields the server requires. */
export function pushableEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.filter(
    (e) =>
      !e.dry_run &&
      typeof e.id === "string" &&
      e.id.length > 0 &&
      typeof e.ts === "string" &&
      !Number.isNaN(Date.parse(e.ts)) &&
      typeof e.command === "string" &&
      typeof e.provider === "string" &&
      typeof e.ok === "boolean",
  );
}

/**
 * The import base URL from `--url`, MULTIX_REMOTE_URL or the default. It must
 * be https:// (http:// only for a loopback host), without credentials, query
 * or fragment, because the account key travels with every request.
 */
export function resolveRemoteUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = flag?.trim() || env[REMOTE_URL_ENV]?.trim() || DEFAULT_REMOTE_URL;
  const source = flag?.trim() ? "--url" : env[REMOTE_URL_ENV]?.trim() ? REMOTE_URL_ENV : "default";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${source} must be an absolute https:// URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new ConfigError(
      `${source} must use https:// (got ${redactUrl(raw)}); plain http:// is only allowed for localhost or a loopback address`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      `${source} must not contain credentials, a query string or a fragment (got ${redactUrl(raw)})`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The account API key from MULTIX_API_KEY (never from a flag). */
export function resolveApiKey(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[API_KEY_ENV]?.trim();
  if (!key) {
    throw new ConfigError(
      `${API_KEY_ENV} is not set. Create an API key in ${baseUrl}/dashboard and set ${API_KEY_ENV} in your shell or ~/.multix/.env.`,
    );
  }
  return key;
}

function isSummary(v: unknown): v is PushSummary {
  const r = v as Record<string, unknown> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    num(r.accepted) !== undefined &&
    num(r.duplicates) !== undefined &&
    num(r.rejected) !== undefined
  );
}

/** The server's `{ error: { code, message } }`, when the body is one. */
function serverError(snippet: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(snippet) as { error?: { code?: unknown; message?: unknown } };
    return {
      code: typeof parsed.error?.code === "string" ? parsed.error.code : undefined,
      message: typeof parsed.error?.message === "string" ? parsed.error.message : undefined,
    };
  } catch {
    return {};
  }
}

export interface PushOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  /** Called after each batch (progress). */
  onBatch?: (done: number, total: number, summary: PushSummary) => void;
}

/**
 * Send entries in batches of 200 and add up the server's counts. A 401/403
 * becomes a ConfigError naming MULTIX_API_KEY; other HTTP failures are
 * rethrown with how many batches went through (pushing again is safe).
 */
export async function pushHistory(entries: ImportEntry[], opts: PushOptions): Promise<PushSummary> {
  const total: PushSummary = { accepted: 0, duplicates: 0, rejected: 0 };
  const batches = Math.ceil(entries.length / PUSH_BATCH_SIZE);
  const url = `${opts.baseUrl}${IMPORT_PATH}`;
  for (let i = 0; i < batches; i++) {
    const batch = entries.slice(i * PUSH_BATCH_SIZE, (i + 1) * PUSH_BATCH_SIZE);
    let res: unknown;
    try {
      res = await fetchJson<unknown>({
        url,
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: { entries: batch },
        timeoutMs: PUSH_TIMEOUT_MS,
        maxBytes: 64 * 1024,
        fetch: opts.fetch,
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        const detail = serverError(error.snippet).message;
        throw new ConfigError(
          `${API_KEY_ENV} was rejected by ${opts.baseUrl} (HTTP ${error.status}: invalid key${detail ? `, ${detail}` : ""}). Create a new key in ${opts.baseUrl}/dashboard.`,
        );
      }
      if (i > 0) {
        console.error(
          `⚠ Sent ${i} of ${batches} batches (${total.accepted} accepted, ${total.duplicates} duplicates) before the error; run the command again, imported runs are skipped.`,
        );
      }
      throw error;
    }
    if (!isSummary(res)) {
      throw new ProviderError(`Unexpected response from ${redactUrl(url)}`, "multix");
    }
    total.accepted += res.accepted;
    total.duplicates += res.duplicates;
    total.rejected += res.rejected;
    opts.onBatch?.(i + 1, batches, res);
  }
  return total;
}
