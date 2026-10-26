/**
 * Builds ledger operations from what the Worker sees: a job handed to its
 * container (start), the job's final view with the container's usage report
 * (finish), and CLI history entries pushed by `multix history push` (import).
 *
 * Only measurements are kept: ids, names, timings, counts, hashes and the
 * numbers a provider reported. Prompts, argv, paths, URLs and error text are
 * never copied; a number nobody reported stays null.
 */

import type { JobTimings, JobUsageReport, JobView } from "../jobs/job-protocol.js";
import type {
  CostProvenance,
  OperationDetail,
  OperationInput,
  OperationOutput,
  OperationSource,
  OperationSpan,
} from "./ledger-types.js";

/** Who started a job, recorded with it: MCP client or REST API key. */
export interface JobOrigin {
  source: OperationSource;
  /** OAuth client id (MCP) or `api_key:<id>` (REST). */
  clientId: string | null;
  clientName: string | null;
}

/** What the job Durable Object keeps about a job for its ledger record. */
export interface JobLedgerMeta extends JobOrigin {
  command: string;
  model: string | null;
  startedAt: number;
}

export const MAX_IMPORT_ENTRIES = 200;
/** Request body cap for /usage/import: 200 entries at well under 1 KB each. */
export const MAX_IMPORT_BODY_BYTES = 512 * 1024;
const MAX_OUTPUTS = 50;
const MAX_PROVIDER_IDS = 10;
const MAX_METRICS = 20;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const COMMAND = /^[a-z0-9][a-z0-9 _.-]{0,99}$/i;
const HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,159}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+=-]{0,127}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MIME = /^[\w.+-]{1,60}\/[\w.+-]{1,100}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const METRIC_KEY = /^[A-Za-z0-9_.[\]-]{1,80}$/;

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const integer = (v: unknown): number | null => {
  const n = count(v);
  return n === null ? null : Math.round(n);
};
const matching = (v: unknown, pattern: RegExp): string | null =>
  typeof v === "string" && pattern.test(v) && !v.includes("//") ? v : null;

/** `--model=value` (or `--model value`) from the job's argv, if it is a plain model id. */
export function modelFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("--model=")) return matching(arg.slice("--model=".length), MODEL);
    if (arg === "--model") return matching(argv[i + 1], MODEL);
  }
  return null;
}

function providerOf(command: string): string {
  return command.split(" ")[0] || "unknown";
}

function cleanProviderIds(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out = [...new Set(ids.map((id) => matching(id, PROVIDER_ID)).filter((id) => id !== null))];
  return out.length ? out.slice(0, MAX_PROVIDER_IDS) : undefined;
}

function cleanMetrics(metrics: unknown): Record<string, number> | undefined {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (Object.keys(out).length >= MAX_METRICS) break;
    if (METRIC_KEY.test(key) && typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanOutputs(outputs: unknown): OperationOutput[] {
  if (!Array.isArray(outputs)) return [];
  const out: OperationOutput[] = [];
  for (const raw of outputs.slice(0, MAX_OUTPUTS)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const bytes = integer(o.bytes);
    if (bytes === null) continue;
    const output: OperationOutput = { bytes };
    const mime = matching(o.mime, MIME);
    if (mime) output.mime = mime.toLowerCase();
    const sha = matching(o.sha256, SHA256);
    if (sha) output.sha256 = sha.toLowerCase();
    const duration = count(o.durationS ?? o.duration_s);
    if (duration !== null) output.duration_s = duration;
    out.push(output);
  }
  return out;
}

function costFields(costUsd: number | null): {
  actual_cost_usd: number | null;
  cost_provenance: CostProvenance;
} {
  return costUsd === null
    ? { actual_cost_usd: null, cost_provenance: "unknown" }
    : { actual_cost_usd: costUsd, cost_provenance: "provider_reported" };
}

function spansFrom(timings: JobTimings | undefined, finishedAt: number): OperationSpan[] {
  if (!timings || count(timings.startedAt) === null) return [];
  const spans: OperationSpan[] = [];
  const phases: Array<[string, number | undefined]> = [
    ["inputs", timings.inputsDoneAt],
    ["cli", timings.cliDoneAt],
    ["uploads", timings.uploadsDoneAt],
  ];
  let start = timings.startedAt;
  for (const [name, end] of phases) {
    if (count(end) === null || (end as number) < start) break;
    spans.push({ name, start, end: end as number });
    start = end as number;
  }
  if (finishedAt > start) spans.push({ name: "finish", start, end: finishedAt });
  return spans;
}

/** The running record written when a job was handed to its container. */
export function jobStartRecord(jobId: string, meta: JobLedgerMeta): OperationInput {
  return {
    op_id: `job_${jobId}`,
    source: meta.source,
    client_id: meta.clientId,
    client_name: meta.clientName,
    project_id: null,
    trace_id: jobId,
    job_id: jobId,
    history_id: null,
    command: meta.command,
    provider: providerOf(meta.command),
    model: meta.model,
    task: null,
    status: "running",
    error_code: null,
    started_at: meta.startedAt,
    finished_at: null,
    duration_ms: null,
    output_count: null,
    output_bytes: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    tokens_thinking: null,
    credits: null,
    credits_unit: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    cost_provenance: "unknown",
    rate_source: null,
    http_requests: null,
    http_errors: null,
    detail: {},
  };
}

const STATUS_ERROR: Record<string, string> = {
  timed_out: "TIMEOUT",
  canceled: "CANCELED",
  failed: "JOB_FAILED",
};

/** The final record of a job from its terminal view (and usage report when the container sent one). */
export function jobFinishRecord(
  jobId: string,
  meta: JobLedgerMeta,
  view: JobView,
  now: number,
): OperationInput {
  const result = view.result;
  const usage: JobUsageReport = result?.usage ?? {};
  const finishedAt = view.finishedAt ?? now;
  const startedAt = Math.min(meta.startedAt, view.createdAt);
  const jobOutputs = result?.outputs ?? [];
  const usageOutputs = cleanOutputs(usage.outputs);
  const status = view.status === "starting" || view.status === "running" ? "failed" : view.status;
  const detail: OperationDetail = {};
  const providerIds = cleanProviderIds(usage.providerIds);
  if (providerIds) detail.provider_ids = providerIds;
  if (usageOutputs.length) detail.outputs = usageOutputs;
  const spans = spansFrom(result?.timings, finishedAt);
  if (spans.length) detail.spans = spans;
  const metrics = cleanMetrics(usage.metrics);
  if (metrics) detail.metrics = metrics;
  const tokens = usage.tokens ?? {};
  const http = usage.http;
  const credits = count(usage.credits);
  return {
    ...jobStartRecord(jobId, meta),
    model: matching(usage.model, MODEL) ?? meta.model,
    status,
    error_code:
      status === "succeeded"
        ? null
        : (matching(usage.errorCode, ERROR_CODE) ?? STATUS_ERROR[status] ?? null),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, finishedAt - startedAt),
    output_count: jobOutputs.length,
    output_bytes: jobOutputs.reduce((sum, o) => sum + (integer(o.bytes) ?? 0), 0),
    tokens_input: integer(tokens.input),
    tokens_output: integer(tokens.output),
    tokens_total: integer(tokens.total),
    tokens_thinking: integer(tokens.thinking),
    credits,
    credits_unit: credits === null ? null : "provider_credits",
    ...costFields(count(usage.costUsd)),
    http_requests: http ? integer(http.requests) : null,
    http_errors: http ? integer(http.errors) : null,
    detail,
  };
}

export interface ImportResult {
  operations: OperationInput[];
  rejected: number;
}

/**
 * Validate the body of POST /usage/import (`{ entries: ImportEntry[] }`, the
 * shape `multix history push` sends). Invalid entries are counted as
 * rejected; the rest become `cli` operations keyed by their history id.
 */
export function importRecords(entries: unknown[], clientId: string): ImportResult {
  const operations: OperationInput[] = [];
  let rejected = 0;
  for (const raw of entries) {
    const op = importRecord(raw, clientId);
    if (op) operations.push(op);
    else rejected++;
  }
  return { operations, rejected };
}

function importRecord(raw: unknown, clientId: string): OperationInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const id = matching(e.id, HISTORY_ID);
  const command = matching(e.command, COMMAND);
  const provider = matching(e.provider, SLUG);
  const startedAt = typeof e.ts === "string" ? Date.parse(e.ts) : Number.NaN;
  if (!id || !command || !provider || typeof e.ok !== "boolean" || !Number.isFinite(startedAt)) {
    return null;
  }
  const durationMs = integer(e.duration_ms);
  const outputs = cleanOutputs(e.outputs);
  const usage = (e.usage && typeof e.usage === "object" ? e.usage : {}) as Record<string, unknown>;
  const tokens = (usage.tokens && typeof usage.tokens === "object" ? usage.tokens : {}) as Record<
    string,
    unknown
  >;
  const http = (e.http && typeof e.http === "object" ? e.http : undefined) as
    | Record<string, unknown>
    | undefined;
  const credits = count(usage.credits);
  const detail: OperationDetail = {};
  const providerIds = cleanProviderIds(e.provider_ids);
  if (providerIds) detail.provider_ids = providerIds;
  if (outputs.length) detail.outputs = outputs;
  const metrics = cleanMetrics(usage.metrics);
  if (metrics) detail.metrics = metrics;
  const version = matching(e.version, VERSION);
  if (version) detail.cli_version = version;
  return {
    op_id: `cli_${id}`,
    source: "cli",
    client_id: clientId,
    client_name: null,
    project_id: null,
    trace_id: `cli_${id}`,
    job_id: null,
    history_id: id,
    command,
    provider,
    model: matching(e.model, MODEL),
    task: null,
    status: e.ok ? "succeeded" : "failed",
    error_code: e.ok ? null : (matching(e.error_code, ERROR_CODE) ?? "CLI_FAILED"),
    started_at: startedAt,
    finished_at: durationMs === null ? null : startedAt + durationMs,
    duration_ms: durationMs,
    output_count: outputs.length,
    output_bytes: outputs.reduce((sum, o) => sum + o.bytes, 0),
    tokens_input: integer(tokens.input),
    tokens_output: integer(tokens.output),
    tokens_total: integer(tokens.total),
    tokens_thinking: integer(tokens.thinking),
    credits,
    credits_unit: credits === null ? null : "provider_credits",
    ...costFields(count(usage.cost_usd)),
    rate_source: null,
    estimated_cost_usd: null,
    http_requests: http ? integer(http.requests) : null,
    http_errors: http ? integer(http.errors) : null,
    detail,
  };
}
