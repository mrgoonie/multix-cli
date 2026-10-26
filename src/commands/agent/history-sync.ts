/**
 * `multix history sync`: opt-in upload of the local run ledger to a multix
 * server's usage import API (POST /api/v1/usage/import), for a shared FinOps
 * view of cost, tokens and credits. It only runs when asked.
 *
 * Each entry is reduced to what usage accounting needs. argv, cwd, error
 * messages, output paths or file names and env values never leave the
 * machine; outputs keep only their extension, size, MIME type, hash and
 * duration. The server deduplicates by history id, so re-running is safe.
 */

import path from "node:path";
import { type HistoryEntry, parseSince, readHistory } from "../../agent/history-store.js";
import { ConfigError, HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { fetchJson } from "../../core/fetch-json.js";

export const DEFAULT_REMOTE_URL = "https://multix.zuey.me";
export const SYNC_BATCH_SIZE = 500;
const PROJECT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HISTORY_ID_RE = /^h_[a-z0-9]{1,40}$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;

export interface CliImportEntry {
  id: string;
  ts: string;
  duration_ms: number;
  version?: string;
  command: string;
  provider: string;
  model?: string;
  ok: boolean;
  exit_code: number;
  error_code?: string;
  outputs?: Array<{
    ext?: string;
    bytes: number;
    mime?: string;
    sha256?: string;
    duration_s?: number;
  }>;
  usage?: {
    tokens?: Record<string, number>;
    cost_usd?: number;
    credits?: number;
    metrics?: Record<string, number>;
  };
  http?: { requests: number; errors: number; ms: number };
  provider_ids?: string[];
}

export interface ImportResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ id: string; reason: string }>;
}

export interface SyncOptions {
  url?: string;
  since?: string;
  project?: string;
  dryRun?: boolean;
}

export interface SyncSummary {
  url: string;
  project?: string;
  dry_run: boolean;
  /** Ledger entries read (after --since). */
  total: number;
  /** Entries sent (or, in a dry run, that would be sent). */
  entries: number;
  batches: number;
  /** Dry runs, local commands without a provider, and malformed lines. */
  skipped: number;
  accepted?: number;
  duplicates?: number;
  rejected?: Array<{ id: string; reason: string }>;
  /** One mapped entry, exactly as it would be sent (dry run only). */
  sample?: CliImportEntry;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Keep only finite numeric values of a flat record. */
function numberRecord(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (isNum(n)) out[k] = n;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lowercase file extension without the dot, when it is a plain short one. */
export function outputExt(file: unknown): string | undefined {
  if (typeof file !== "string") return undefined;
  const ext = path.extname(file).slice(1).toLowerCase();
  return EXT_RE.test(ext) ? ext : undefined;
}

/**
 * Map one ledger entry to the import shape, or undefined when it must not be
 * sent (dry run, no provider, missing or malformed fields). Built field by
 * field from an allowlist so nothing private is carried over by accident.
 */
export function toImportEntry(e: HistoryEntry): CliImportEntry | undefined {
  if (!e || typeof e !== "object" || e.dry_run) return undefined;
  if (typeof e.id !== "string" || !HISTORY_ID_RE.test(e.id)) return undefined;
  if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) return undefined;
  if (!isStr(e.command) || !isStr(e.provider) || typeof e.ok !== "boolean") return undefined;
  if (!isNum(e.duration_ms) || !isNum(e.exit_code)) return undefined;

  const out: CliImportEntry = {
    id: e.id,
    ts: new Date(e.ts).toISOString(),
    duration_ms: e.duration_ms,
    ...(isStr(e.version) ? { version: e.version } : {}),
    command: e.command,
    provider: e.provider,
    ...(isStr(e.model) ? { model: e.model } : {}),
    ok: e.ok,
    exit_code: e.exit_code,
    ...(isStr(e.error?.code) ? { error_code: e.error.code } : {}),
  };

  if (Array.isArray(e.outputs)) {
    const outputs = e.outputs
      .filter((o) => o && isNum(o.bytes))
      .map((o) => {
        const ext = outputExt(o.path);
        return {
          ...(ext ? { ext } : {}),
          bytes: o.bytes,
          ...(isStr(o.mime) ? { mime: o.mime } : {}),
          ...(isStr(o.sha256) ? { sha256: o.sha256 } : {}),
          ...(isNum(o.duration_s) ? { duration_s: o.duration_s } : {}),
        };
      });
    if (outputs.length > 0) out.outputs = outputs;
  }

  if (e.usage && typeof e.usage === "object") {
    const tokens = numberRecord(e.usage.tokens);
    const metrics = numberRecord(e.usage.metrics);
    const usage: NonNullable<CliImportEntry["usage"]> = {
      ...(tokens ? { tokens } : {}),
      ...(isNum(e.usage.cost_usd) ? { cost_usd: e.usage.cost_usd } : {}),
      ...(isNum(e.usage.credits) ? { credits: e.usage.credits } : {}),
      ...(metrics ? { metrics } : {}),
    };
    if (Object.keys(usage).length > 0) out.usage = usage;
  }

  const h = e.http;
  if (h && isNum(h.requests) && isNum(h.errors) && isNum(h.ms)) {
    out.http = { requests: h.requests, errors: h.errors, ms: h.ms };
  }

  if (Array.isArray(e.provider_ids)) {
    const ids = e.provider_ids.filter(isStr);
    if (ids.length > 0) out.provider_ids = ids;
  }
  return out;
}

/** Server origin from --url or MULTIX_REMOTE_URL: https, or http for localhost only. */
export function resolveRemoteUrl(value?: string): string {
  const raw = value?.trim() || process.env.MULTIX_REMOTE_URL?.trim() || DEFAULT_REMOTE_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid --url: ${raw}. Use an origin such as ${DEFAULT_REMOTE_URL}`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new ValidationError(
      `Invalid --url: ${u.origin}. Use https (http only for localhost or 127.0.0.1).`,
    );
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new ValidationError(
      `Invalid --url: give the server origin only, such as ${DEFAULT_REMOTE_URL}`,
    );
  }
  return u.origin;
}

export function validateProject(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!PROJECT_RE.test(value)) {
    throw new ValidationError(
      "Invalid --project: use 1-64 characters from letters, digits, '.', '_' and '-'.",
    );
  }
  return value;
}

function parseImportResponse(body: unknown, url: string): ImportResponse {
  const r = body as Partial<ImportResponse> | undefined;
  if (!r || !isNum(r.accepted) || !isNum(r.duplicates) || !Array.isArray(r.rejected)) {
    throw new ProviderError(`Unexpected response from ${url}/api/v1/usage/import`, "multix");
  }
  return {
    accepted: r.accepted,
    duplicates: r.duplicates,
    rejected: r.rejected
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ id: String(x.id ?? ""), reason: String(x.reason ?? "") })),
  };
}

/** Read, map and (unless a dry run) upload the ledger in batches. */
export async function syncHistory(opts: SyncOptions): Promise<SyncSummary> {
  const url = resolveRemoteUrl(opts.url);
  const project = validateProject(opts.project);
  let since: number | undefined;
  if (opts.since) {
    try {
      since = parseSince(opts.since);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
  }
  const key = process.env.MULTIX_API_KEY?.trim();
  if (!opts.dryRun && !key) {
    throw new ConfigError(
      `MULTIX_API_KEY is not set. Create an account API key at ${url}/dashboard and export it (it is never accepted as a flag).`,
    );
  }

  const read = readHistory().filter((e) => since === undefined || Date.parse(e?.ts) >= since);
  const entries = read.map(toImportEntry).filter((e): e is CliImportEntry => e !== undefined);
  const batches = Math.ceil(entries.length / SYNC_BATCH_SIZE);
  const summary: SyncSummary = {
    url,
    ...(project ? { project } : {}),
    dry_run: Boolean(opts.dryRun),
    total: read.length,
    entries: entries.length,
    batches,
    skipped: read.length - entries.length,
  };
  if (opts.dryRun) {
    if (entries[0]) summary.sample = entries[0];
    return summary;
  }

  summary.accepted = 0;
  summary.duplicates = 0;
  summary.rejected = [];
  for (let i = 0; i < batches; i++) {
    const batch = entries.slice(i * SYNC_BATCH_SIZE, (i + 1) * SYNC_BATCH_SIZE);
    let body: unknown;
    try {
      body = await fetchJson<unknown>({
        url: `${url}/api/v1/usage/import`,
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { entries: batch, ...(project ? { project } : {}) },
      });
    } catch (err) {
      const progress =
        i > 0 ? ` ${i} of ${batches} batches were imported; re-running sync is safe.` : "";
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new ConfigError(
          `${url} rejected MULTIX_API_KEY (HTTP ${err.status}). Check the key in the API keys card at ${url}/dashboard.${progress}`,
        );
      }
      if (progress && err instanceof Error) err.message += progress;
      throw err;
    }
    const res = parseImportResponse(body, url);
    summary.accepted += res.accepted;
    summary.duplicates += res.duplicates;
    summary.rejected.push(...res.rejected);
  }
  return summary;
}

/** Human-readable lines for a sync summary. */
export function formatSyncSummary(s: SyncSummary): string[] {
  const skipped = s.skipped ? `, ${s.skipped} skipped (dry runs, local commands, malformed)` : "";
  const scope = s.project ? ` (project ${s.project})` : "";
  if (s.dry_run) {
    const lines = [
      `Dry run: would send ${s.entries} of ${s.total} runs to ${s.url}${scope} in ${s.batches} batch(es)${skipped}.`,
    ];
    if (s.sample) lines.push("Sample entry:", JSON.stringify(s.sample, null, 2));
    return lines;
  }
  if (s.entries === 0) return [`Nothing to sync: no runs to send${skipped}.`];
  const rejected = s.rejected ?? [];
  const lines = [
    `Synced ${s.entries} runs to ${s.url}${scope}: ${s.accepted ?? 0} accepted, ${s.duplicates ?? 0} duplicates, ${rejected.length} rejected${skipped}.`,
  ];
  for (const r of rejected.slice(0, 10)) lines.push(`  rejected ${r.id}: ${r.reason}`);
  if (rejected.length > 10) lines.push(`  … ${rejected.length - 10} more (use --json for all)`);
  return lines;
}
