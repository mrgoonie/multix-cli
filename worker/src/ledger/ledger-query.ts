/**
 * Query parameters and export formats shared by the REST API and the
 * dashboard: one parser for usage filters (so both surfaces accept the same
 * values) and the CSV writer for usage exports.
 */

import {
  GROUP_BYS,
  type GroupBy,
  OPERATION_SOURCES,
  OPERATION_STATUSES,
  type Operation,
  type OperationFilter,
  type OperationSource,
  type OperationStatus,
} from "./ledger-types.js";

const DAY_MS = 86_400_000;
export const DEFAULT_RANGE_DAYS = 30;
/** Longest range a summary or export covers (the retention period). */
export const MAX_RANGE_DAYS = 400;
/** Charset of filter values (provider, model, command, client and project ids). */
export const FILTER_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,199}$/;

export class LedgerQueryError extends Error {
  override name = "LedgerQueryError";
}

/** Epoch milliseconds or an ISO date/time; undefined when absent. */
export function parseTime(raw: string | null, name: string): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  const ms = /^\d{1,16}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms))
    throw new LedgerQueryError(`${name} must be epoch milliseconds or an ISO date`);
  return ms;
}

function parseValue(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  if (!FILTER_VALUE.test(raw)) throw new LedgerQueryError(`${name} is not a valid value`);
  return raw;
}

function parseOneOf<T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new LedgerQueryError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export interface UsageQuery {
  filter: OperationFilter & { from: number; to: number };
  groupBy: GroupBy | null;
  tzOffsetMinutes: number;
}

/**
 * `from`, `to` (default: the last 30 days), `provider`, `model`, `source`,
 * `status`, `command`, `client_id`, `project_id`, `group_by` and
 * `tz_offset_minutes` (minutes east of UTC, for daily buckets).
 */
export function parseUsageQuery(params: URLSearchParams, now: number): UsageQuery {
  const to = parseTime(params.get("to"), "to") ?? now;
  const from = parseTime(params.get("from"), "from") ?? to - DEFAULT_RANGE_DAYS * DAY_MS;
  if (from >= to) throw new LedgerQueryError("from must be before to");
  if (to - from > MAX_RANGE_DAYS * DAY_MS) {
    throw new LedgerQueryError(`the range may cover at most ${MAX_RANGE_DAYS} days`);
  }
  const tzRaw = params.get("tz_offset_minutes");
  const tz = tzRaw === null || tzRaw === "" ? 0 : Number(tzRaw);
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) {
    throw new LedgerQueryError("tz_offset_minutes must be an integer between -840 and 840");
  }
  const filter: OperationFilter & { from: number; to: number } = { from, to };
  const provider = parseValue(params, "provider");
  if (provider) filter.provider = provider;
  const model = parseValue(params, "model");
  if (model) filter.model = model;
  const command = parseValue(params, "command");
  if (command) filter.command = command;
  const clientId = parseValue(params, "client_id");
  if (clientId) filter.client_id = clientId;
  const projectId = parseValue(params, "project_id");
  if (projectId) filter.project_id = projectId;
  const source = parseOneOf<OperationSource>(params, "source", OPERATION_SOURCES);
  if (source) filter.source = source;
  const status = parseOneOf<OperationStatus>(params, "status", OPERATION_STATUSES);
  if (status) filter.status = status;
  return {
    filter,
    groupBy: parseOneOf<GroupBy>(params, "group_by", GROUP_BYS) ?? null,
    tzOffsetMinutes: tz,
  };
}

/** `limit` between 1 and `max` (default `fallback`). */
export function parseLimit(params: URLSearchParams, fallback: number, max: number): number {
  const raw = params.get("limit");
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new LedgerQueryError(`limit must be an integer between 1 and ${max}`);
  }
  return n;
}

export const CSV_COLUMNS = [
  "op_id",
  "started_at",
  "finished_at",
  "source",
  "client_id",
  "project_id",
  "command",
  "provider",
  "model",
  "status",
  "error_code",
  "duration_ms",
  "output_count",
  "output_bytes",
  "tokens_input",
  "tokens_output",
  "tokens_total",
  "credits",
  "credits_unit",
  "estimated_cost_usd",
  "actual_cost_usd",
  "currency",
  "cost_provenance",
  "http_requests",
  "http_errors",
  "job_id",
  "history_id",
] as const satisfies readonly (keyof Operation)[];

/** One CSV cell: quoted when needed, and never starting like a spreadsheet formula. */
function csvCell(value: unknown, column: string): string {
  if (value === null || value === undefined) return "";
  let text =
    column === "started_at" || column === "finished_at"
      ? new Date(Number(value)).toISOString()
      : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV of operations (empty cells for unknown values, times in ISO 8601 UTC). */
export function operationsCsv(operations: Operation[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const op of operations) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(op[column], column)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
