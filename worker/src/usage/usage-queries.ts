/**
 * Read side of the usage ledger: filters, KPIs, time series, breakdowns,
 * event pages and exports. Every number the dashboard, the REST API and the
 * MCP tool show comes from here, so they agree.
 *
 * Cost of one event = provider-reported or billed USD, else the rate-card
 * estimate, plus its refunds and corrections. A run that may have cost money
 * but has neither is counted in `unknownCostRuns`, never as $0.
 */

import { type SqlPort, type SqlValue, v } from "./sql-port.js";
import { type EventRow, toEvent } from "./usage-rows.js";
import {
  USAGE_SOURCES,
  USAGE_STATUSES,
  type UsageBreakdownRow,
  type UsageBucket,
  type UsageEvent,
  type UsageFilter,
  type UsageKpis,
  type UsageSource,
  type UsageStatus,
  type UsageSummary,
} from "./usage-types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 1970-01-01 was a Thursday; shifting by 3 days aligns weeks on Monday. */
const MONDAY_SHIFT = 3 * DAY;
export const MAX_RANGE_DAYS = 400;
export const MAX_EVENT_PAGE = 100;
export const MAX_EXPORT_ROWS = 10_000;
const BREAKDOWN_LIMIT = 10;
const FILTER_VALUE_RE = /^[A-Za-z0-9._:/ -]{1,128}$/;

export class FilterError extends Error {}

function parseTime(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(n)) throw new FilterError(`${name} must be a date or epoch milliseconds`);
  return n;
}

/**
 * Filters from query parameters (`from`, `to`, `provider`, `model`, `source`,
 * `project`, `client`, `status`, `command`, `q`). Default: the last 30 days.
 * A date-only `to` (YYYY-MM-DD) includes that whole day.
 */
export function parseUsageFilter(params: URLSearchParams, now: number): UsageFilter {
  const toRaw = params.get("to");
  let to = parseTime(toRaw, "to") ?? now;
  if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) to += DAY;
  const from = parseTime(params.get("from"), "from") ?? to - 30 * DAY;
  if (from >= to) throw new FilterError("from must be before to");
  if (to - from > MAX_RANGE_DAYS * DAY)
    throw new FilterError(`range is at most ${MAX_RANGE_DAYS} days`);
  const filter: UsageFilter = { from, to };
  for (const key of ["provider", "model", "project", "client", "command"] as const) {
    const value = params.get(key);
    if (!value) continue;
    if (!FILTER_VALUE_RE.test(value)) throw new FilterError(`${key} has unsupported characters`);
    filter[key] = value;
  }
  const source = params.get("source");
  if (source) {
    if (!USAGE_SOURCES.includes(source as UsageSource)) {
      throw new FilterError(`source must be one of ${USAGE_SOURCES.join(", ")}`);
    }
    filter.source = source as UsageSource;
  }
  const status = params.get("status");
  if (status) {
    if (!USAGE_STATUSES.includes(status as UsageStatus)) {
      throw new FilterError(`status must be one of ${USAGE_STATUSES.join(", ")}`);
    }
    filter.status = status as UsageStatus;
  }
  const q = params.get("q");
  if (q) filter.q = q.slice(0, 100);
  return filter;
}

/** Filter as query parameters, for links that keep the current view. */
export function filterParams(filter: UsageFilter): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", new Date(filter.from).toISOString());
  params.set("to", new Date(filter.to).toISOString());
  for (const key of [
    "provider",
    "model",
    "source",
    "project",
    "client",
    "status",
    "command",
    "q",
  ] as const) {
    const value = filter[key];
    if (value) params.set(key, value);
  }
  return params;
}

function where(filter: UsageFilter): { sql: string; params: SqlValue[] } {
  const parts = ["e.started_at >= ?", "e.started_at < ?"];
  const params: SqlValue[] = [filter.from, filter.to];
  const eq: Array<[keyof UsageFilter, string]> = [
    ["provider", "e.provider"],
    ["source", "e.source"],
    ["project", "e.project"],
    ["client", "e.client_id"],
    ["status", "e.status"],
    ["command", "e.command"],
  ];
  for (const [key, column] of eq) {
    const value = filter[key];
    if (value === undefined) continue;
    parts.push(`${column} = ?`);
    params.push(v(value as string));
  }
  if (filter.model) {
    parts.push("coalesce(e.model_resolved, e.model_requested) = ?");
    params.push(filter.model);
  }
  if (filter.q) {
    parts.push(
      "(instr(e.command, ?) > 0 OR instr(coalesce(e.model_resolved, e.model_requested, ''), ?) > 0 OR instr(e.provider, ?) > 0 OR instr(coalesce(e.error_code, ''), ?) > 0 OR e.id = ?)",
    );
    params.push(filter.q, filter.q, filter.q, filter.q, filter.q);
  }
  return { sql: parts.join(" AND "), params };
}

/** Filtered events with their adjustment sum (`adj`) and cost columns. */
function base(filter: UsageFilter): { sql: string; params: SqlValue[] } {
  const w = where(filter);
  return {
    sql: `WITH ev AS (
      SELECT e.*,
        (SELECT coalesce(sum(a.amount_usd), 0) FROM adjustments a WHERE a.event_id = e.id AND a.kind != 'billed') AS adj,
        CASE WHEN e.actual_cost_usd IS NULL AND e.estimated_cost_usd IS NULL AND e.charge_state IN ('charged', 'uncertain') THEN 1 ELSE 0 END AS unknown_cost
      FROM usage_events e WHERE ${w.sql})`,
    params: w.params,
  };
}

const KNOWN = "(coalesce(actual_cost_usd, estimated_cost_usd, 0) + adj)";
const round = (n: number | null | undefined) => Math.round((n ?? 0) * 1e6) / 1e6;
const num = (n: unknown) => Number(n ?? 0);

export type Bucket = "hour" | "day" | "week";

/** Bucket size that keeps a chart readable for the range. */
export function pickBucket(filter: UsageFilter): Bucket {
  const span = filter.to - filter.from;
  if (span <= 2 * DAY) return "hour";
  if (span <= 120 * DAY) return "day";
  return "week";
}

function bucketStart(at: number, bucket: Bucket, tzMs: number): number {
  if (bucket === "hour") return Math.floor(at / HOUR) * HOUR;
  if (bucket === "day") return Math.floor((at + tzMs) / DAY) * DAY - tzMs;
  return Math.floor((at + tzMs + MONDAY_SHIFT) / (7 * DAY)) * 7 * DAY - MONDAY_SHIFT - tzMs;
}

function bucketKey(start: number, bucket: Bucket, tzMs: number): string {
  const iso = new Date(start + tzMs).toISOString();
  return bucket === "hour" ? `${iso.slice(0, 13)}:00` : iso.slice(0, 10);
}

export class UsageQueries {
  constructor(private readonly sql: SqlPort) {}

  kpis(filter: UsageFilter): UsageKpis {
    const b = base(filter);
    const row =
      this.sql.exec(
        `${b.sql} SELECT
        count(*) AS jobs,
        sum(status = 'succeeded') AS succeeded,
        sum(status IN ('failed', 'timed_out', 'canceled')) AS failed,
        sum(status = 'rejected') AS rejected,
        sum(coalesce(actual_cost_usd, 0)) AS actual,
        sum(CASE WHEN actual_cost_usd IS NULL THEN coalesce(estimated_cost_usd, 0) ELSE 0 END) AS estimated,
        sum(adj) AS adj,
        sum(unknown_cost) AS unknown_cost,
        sum(charge_state = 'uncertain') AS uncertain,
        sum(credits) AS credits,
        sum(coalesce(output_count, 0)) AS outputs,
        sum(coalesce(output_bytes, 0)) AS output_bytes,
        sum(CASE WHEN status = 'succeeded' AND unknown_cost = 0 THEN ${KNOWN} ELSE 0 END) AS known_ok_usd,
        sum(CASE WHEN status = 'succeeded' AND unknown_cost = 0 THEN 1 ELSE 0 END) AS known_ok_runs,
        sum(CASE WHEN status = 'succeeded' AND unknown_cost = 0 THEN coalesce(output_count, 0) ELSE 0 END) AS known_ok_outputs,
        sum(coalesce(http_requests, 0)) AS http_requests,
        sum(coalesce(http_errors, 0)) AS http_errors,
        sum(coalesce(tokens_input, 0)) AS tokens_input,
        sum(coalesce(tokens_output, 0)) AS tokens_output
      FROM ev`,
        ...b.params,
      )[0] ?? {};
    const jobs = num(row.jobs);
    const succeeded = num(row.succeeded);
    const failed = num(row.failed);
    const actualUsd = round(num(row.actual));
    const estimatedUsd = round(num(row.estimated));
    const adjustmentsUsd = round(num(row.adj));
    const knownOkRuns = num(row.known_ok_runs);
    const knownOkOutputs = num(row.known_ok_outputs);
    const [p50Ms = null, p95Ms = null] = this.percentiles(filter, [0.5, 0.95]);
    return {
      jobs,
      succeeded,
      failed,
      rejected: num(row.rejected),
      successRate:
        succeeded + failed > 0 ? Math.round((succeeded / (succeeded + failed)) * 1000) / 10 : null,
      actualUsd,
      estimatedUsd,
      adjustmentsUsd,
      knownUsd: round(actualUsd + estimatedUsd + adjustmentsUsd),
      unknownCostRuns: num(row.unknown_cost),
      uncertainRuns: num(row.uncertain),
      credits: row.credits === null || row.credits === undefined ? null : round(num(row.credits)),
      outputs: num(row.outputs),
      outputBytes: num(row.output_bytes),
      costPerOutputUsd: knownOkOutputs > 0 ? round(num(row.known_ok_usd) / knownOkOutputs) : null,
      costPerSucceededRunUsd: knownOkRuns > 0 ? round(num(row.known_ok_usd) / knownOkRuns) : null,
      p50Ms,
      p95Ms,
      httpRequests: num(row.http_requests),
      httpErrors: num(row.http_errors),
      tokensInput: num(row.tokens_input),
      tokensOutput: num(row.tokens_output),
    };
  }

  /** Nearest-rank percentiles of finished runs' duration. */
  private percentiles(filter: UsageFilter, ps: number[]): Array<number | null> {
    const w = where(filter);
    const cond = `${w.sql} AND e.duration_ms IS NOT NULL AND e.status NOT IN ('submitted', 'rejected')`;
    const n = num(
      this.sql.exec(`SELECT count(*) AS n FROM usage_events e WHERE ${cond}`, ...w.params)[0]?.n,
    );
    if (n === 0) return ps.map(() => null);
    return ps.map((p) => {
      const offset = Math.max(0, Math.ceil(p * n) - 1);
      const row = this.sql.exec(
        `SELECT e.duration_ms AS d FROM usage_events e WHERE ${cond} ORDER BY e.duration_ms LIMIT 1 OFFSET ?`,
        ...w.params,
        offset,
      )[0];
      return row ? num(row.d) : null;
    });
  }

  series(filter: UsageFilter, bucket: Bucket, tzOffsetMinutes: number): UsageBucket[] {
    const tzMs = tzOffsetMinutes * 60_000;
    const b = base(filter);
    const size = bucket === "hour" ? HOUR : bucket === "day" ? DAY : 7 * DAY;
    const shift = bucket === "week" ? MONDAY_SHIFT : 0;
    const offset = bucket === "hour" ? 0 : tzMs + shift;
    const rows = this.sql.exec(
      `${b.sql} SELECT
        CAST((started_at + ?) / ? AS INTEGER) * ? - ? AS start,
        count(*) AS jobs,
        sum(status = 'succeeded') AS succeeded,
        sum(${KNOWN}) AS known,
        sum(CASE WHEN actual_cost_usd IS NULL THEN coalesce(estimated_cost_usd, 0) ELSE 0 END) AS estimated,
        sum(unknown_cost) AS unknown_cost,
        sum(coalesce(credits, 0)) AS credits
      FROM ev GROUP BY 1 ORDER BY 1`,
      ...b.params,
      offset,
      size,
      size,
      offset,
    );
    const byStart = new Map(rows.map((r) => [num(r.start), r]));
    const out: UsageBucket[] = [];
    const last = bucketStart(filter.to - 1, bucket, tzMs);
    for (
      let start = bucketStart(filter.from, bucket, tzMs);
      start <= last && out.length < 1000;
      start += size
    ) {
      const r = byStart.get(start);
      out.push({
        key: bucketKey(start, bucket, tzMs),
        start,
        jobs: num(r?.jobs),
        succeeded: num(r?.succeeded),
        knownUsd: round(num(r?.known)),
        estimatedUsd: round(num(r?.estimated)),
        unknownCostRuns: num(r?.unknown_cost),
        credits: round(num(r?.credits)),
      });
    }
    return out;
  }

  breakdown(filter: UsageFilter, dimension: keyof UsageSummary["breakdown"]): UsageBreakdownRow[] {
    const column = {
      provider: "provider",
      model: "coalesce(model_resolved, model_requested, '(none)')",
      source: "source",
      command: "command",
      client: "coalesce(client_id, '(none)')",
      project: "coalesce(project, '(none)')",
      status: "status",
    }[dimension];
    const b = base(filter);
    return this.sql
      .exec(
        `${b.sql} SELECT ${column} AS key,
          count(*) AS jobs,
          sum(status = 'succeeded') AS succeeded,
          sum(${KNOWN}) AS known,
          sum(unknown_cost) AS unknown_cost,
          sum(coalesce(credits, 0)) AS credits,
          sum(coalesce(output_count, 0)) AS outputs,
          avg(CASE WHEN status NOT IN ('submitted', 'rejected') THEN duration_ms END) AS avg_ms
        FROM ev GROUP BY 1 ORDER BY known DESC, jobs DESC LIMIT ?`,
        ...b.params,
        BREAKDOWN_LIMIT,
      )
      .map((r) => ({
        key: String(r.key),
        jobs: num(r.jobs),
        succeeded: num(r.succeeded),
        knownUsd: round(num(r.known)),
        unknownCostRuns: num(r.unknown_cost),
        credits: round(num(r.credits)),
        outputs: num(r.outputs),
        avgMs: r.avg_ms === null || r.avg_ms === undefined ? null : Math.round(num(r.avg_ms)),
      }));
  }

  summary(filter: UsageFilter, tzOffsetMinutes = 0, bucket = pickBucket(filter)): UsageSummary {
    const dims = ["provider", "model", "source", "command", "client", "project", "status"] as const;
    return {
      filter,
      bucket,
      tzOffsetMinutes,
      kpis: this.kpis(filter),
      series: this.series(filter, bucket, tzOffsetMinutes),
      breakdown: Object.fromEntries(
        dims.map((d) => [d, this.breakdown(filter, d)]),
      ) as UsageSummary["breakdown"],
    };
  }

  /** Newest first; `cursor` is the `next` of the previous page. */
  events(
    filter: UsageFilter,
    cursor: string | null,
    limit = 50,
  ): { items: UsageEvent[]; next: string | null } {
    const b = base(filter);
    const size = Math.min(Math.max(limit, 1), MAX_EVENT_PAGE);
    let after = "";
    const params: SqlValue[] = [...b.params];
    if (cursor) {
      const m = /^(\d+)~([A-Za-z0-9_-]{1,128})$/.exec(cursor);
      if (!m) throw new FilterError("cursor is not valid");
      after = "WHERE (started_at < ? OR (started_at = ? AND id < ?))";
      params.push(Number(m[1]), Number(m[1]), m[2] as string);
    }
    const rows = this.sql.exec<EventRow & { adj: number }>(
      `${b.sql} SELECT * FROM ev ${after} ORDER BY started_at DESC, id DESC LIMIT ?`,
      ...params,
      size + 1,
    );
    const items = rows.slice(0, size).map((r) => toEvent(r, r.adj));
    const lastItem = items[items.length - 1];
    return {
      items,
      next: rows.length > size && lastItem ? `${lastItem.startedAt}~${lastItem.id}` : null,
    };
  }

  event(id: string): UsageEvent | null {
    const row = this.sql.exec<EventRow & { adj: number }>(
      `SELECT e.*, (SELECT coalesce(sum(a.amount_usd), 0) FROM adjustments a WHERE a.event_id = e.id AND a.kind != 'billed') AS adj
       FROM usage_events e WHERE e.id = ?`,
      id,
    )[0];
    return row ? toEvent(row, row.adj) : null;
  }

  /** Up to MAX_EXPORT_ROWS events, newest first, with `truncated` set when more matched. */
  export(filter: UsageFilter): { items: UsageEvent[]; truncated: boolean } {
    const b = base(filter);
    const rows = this.sql.exec<EventRow & { adj: number }>(
      `${b.sql} SELECT * FROM ev ORDER BY started_at DESC, id DESC LIMIT ?`,
      ...b.params,
      MAX_EXPORT_ROWS + 1,
    );
    return {
      items: rows.slice(0, MAX_EXPORT_ROWS).map((r) => toEvent(r, r.adj)),
      truncated: rows.length > MAX_EXPORT_ROWS,
    };
  }
}

export const CSV_COLUMNS = [
  "id",
  "started_at",
  "finished_at",
  "source",
  "client_id",
  "project",
  "command",
  "provider",
  "model",
  "status",
  "error_code",
  "duration_ms",
  "outputs",
  "output_bytes",
  "tokens_input",
  "tokens_output",
  "credits",
  "actual_cost_usd",
  "estimated_cost_usd",
  "adjustment_usd",
  "provenance",
  "charge_state",
  "rate_version",
] as const;

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // Leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(events: UsageEvent[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of events) {
    lines.push(
      [
        e.id,
        new Date(e.startedAt).toISOString(),
        e.finishedAt === null ? null : new Date(e.finishedAt).toISOString(),
        e.source,
        e.clientId,
        e.project,
        e.command,
        e.provider,
        e.modelResolved ?? e.modelRequested,
        e.status,
        e.errorCode,
        e.durationMs,
        e.outputCount,
        e.outputBytes,
        e.tokensInput,
        e.tokensOutput,
        e.credits,
        e.actualCostUsd,
        e.estimatedCostUsd,
        e.adjustmentUsd,
        e.provenance,
        e.chargeState,
        e.rateVersion,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
