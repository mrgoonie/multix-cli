/**
 * One account's usage ledger: the write side. Every method runs its writes
 * in one synchronous transaction, so a Durable Object request cannot
 * interleave with another halfway through.
 *
 * - Remote jobs: `begin` records the run and checks budgets before the job
 *   starts; `release` marks a job that never started; `settle` records its
 *   final facts once. Replays of either are no-ops (the job id is the key).
 * - CLI history imports: `importCli`, keyed by `cli_<history id>`.
 * - Corrections: `adjust` (refund, correction, billed amount).
 *
 * The ledger never stores prompts, argv, stdout, keys or URLs: callers pass
 * counts, ids, fixed wording and redacted text only.
 */

import { sanitizeText } from "../redaction.js";
import { ActivityLog } from "./activity-log.js";
import { BudgetEngine } from "./budget-engine.js";
import { RateCard, type RunQuantities } from "./rate-card.js";
import { type SqlPort, type SqlValue, v } from "./sql-port.js";
import { EVENT_COLUMNS, type EventRow, toEvent } from "./usage-rows.js";
import { migrate } from "./usage-schema.js";
import {
  type BeginInput,
  type BeginResult,
  type ChargeState,
  type CliImportEntry,
  type CostProvenance,
  type ImportResult,
  type RunUsage,
  type SettleInput,
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
  type UsageOutput,
  type UsageSpan,
} from "./usage-types.js";

const DAY = 86_400_000;
/** How long usage events, activities and alerts are kept. */
export const RETENTION_DAYS = 400;
/** A hold whose job never settled (its Durable Object was lost) becomes uncertain after this. */
const STALE_HOLD_MS = 8 * DAY;
export const DEBUG_CAPTURE_MS = 7 * DAY;
const MAX_DEBUG_TEXT = 4096;
export const MAX_IMPORT_ENTRIES = 500;
const HISTORY_ID_RE = /^h_[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9._:/ -]{1,128}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const NOT_STARTED_RE = /could not be started|refused|invalid job/i;

export class UsageInputError extends Error {}

export type AdjustmentKind = "refund" | "correction" | "billed";

export interface AdjustmentInput {
  kind: AdjustmentKind;
  amountUsd: number;
  reason: string;
}

export interface Adjustment extends AdjustmentInput {
  id: string;
  eventId: string;
  actor: string;
  createdAt: number;
}

type EventValues = Partial<Record<(typeof EVENT_COLUMNS)[number], SqlValue>>;

const finite = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;
const nonNegative = (n: unknown): number | null => {
  const f = finite(n);
  return f !== null && f >= 0 ? f : null;
};
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

function safeName(value: unknown): string | null {
  return typeof value === "string" && NAME_RE.test(value) ? value : null;
}

function safeMetrics(metrics: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!metrics || typeof metrics !== "object") return out;
  for (const [key, value] of Object.entries(metrics).slice(0, 40)) {
    const n = finite(value);
    if (n !== null && /^[A-Za-z0-9_.:-]{1,80}$/.test(key)) out[key] = n;
  }
  return out;
}

/** Usage columns from a CLI usage summary; missing numbers stay null. */
function usageValues(usage: RunUsage | undefined): EventValues {
  const metrics = safeMetrics(usage?.metrics);
  const characters = Object.entries(metrics).find(([k]) =>
    /(?:^|[._])(?:characters|character_count)$/.test(k),
  );
  return {
    tokens_input: nonNegative(usage?.tokens?.input),
    tokens_output: nonNegative(usage?.tokens?.output),
    tokens_total: nonNegative(usage?.tokens?.total),
    tokens_thinking: nonNegative(usage?.tokens?.thinking),
    characters: characters ? nonNegative(characters[1]) : null,
    credits: nonNegative(usage?.credits),
    metrics_json: Object.keys(metrics).length ? JSON.stringify(metrics) : null,
  };
}

function outputsValues(outputs: UsageOutput[]): EventValues {
  const audio = outputs.filter((o) => o.mime?.startsWith("audio/") && o.durationS !== undefined);
  return {
    output_count: outputs.length,
    output_bytes: outputs.reduce((sum, o) => sum + o.bytes, 0),
    outputs_json: JSON.stringify(outputs.slice(0, 50)),
    audio_seconds: audio.length ? audio.reduce((s, o) => s + (o.durationS ?? 0), 0) : null,
  };
}

function providerIds(ids: unknown): string | null {
  if (!Array.isArray(ids)) return null;
  const clean = ids.filter((id): id is string => typeof id === "string" && PROVIDER_ID_RE.test(id));
  return clean.length ? JSON.stringify(clean.slice(0, 20)) : null;
}

function quantities(
  values: EventValues,
  outputs: UsageOutput[],
  succeeded: boolean,
): RunQuantities {
  const seconds = outputs.filter((o) => o.durationS !== undefined);
  return {
    outputs: succeeded ? outputs.length : 0,
    outputSeconds: seconds.length ? seconds.reduce((s, o) => s + (o.durationS ?? 0), 0) : null,
    tokensInput: values.tokens_input as number | null,
    tokensOutput: values.tokens_output as number | null,
    credits: values.credits as number | null,
  };
}

/** Redacted stderr tail for the debug log: no URLs' queries, no bearer tokens, at most 4 KB. */
export function debugText(text: string): string {
  const clean = text
    .split("\n")
    .map((line) => sanitizeText(line, []))
    .join("\n");
  return clean.length > MAX_DEBUG_TEXT ? clean.slice(-MAX_DEBUG_TEXT) : clean;
}

export class UsageLedger {
  readonly activities: ActivityLog;
  readonly rateCard: RateCard;
  readonly budgets: BudgetEngine;

  constructor(
    readonly sql: SqlPort,
    readonly now: () => number = Date.now,
  ) {
    migrate(sql);
    this.activities = new ActivityLog(sql, now);
    this.rateCard = new RateCard(sql);
    this.budgets = new BudgetEngine(sql, now, this.activities);
  }

  private row(id: string): EventRow | undefined {
    return this.sql.exec<EventRow>("SELECT * FROM usage_events WHERE id = ?", id)[0];
  }

  private insert(values: EventValues): void {
    const at = this.now();
    const row: EventValues = {
      schema_version: USAGE_SCHEMA_VERSION,
      attempt: 1,
      currency: "USD",
      settled: 0,
      created_at: at,
      updated_at: at,
      ...values,
    };
    this.sql.exec(
      `INSERT INTO usage_events (${EVENT_COLUMNS.join(", ")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})`,
      ...EVENT_COLUMNS.map((c) => v(row[c] ?? null)),
    );
  }

  private update(id: string, values: EventValues): void {
    const entries = Object.entries({ ...values, updated_at: this.now() });
    this.sql.exec(
      `UPDATE usage_events SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...entries.map(([, value]) => v(value ?? null)),
      id,
    );
  }

  private setReservation(jobId: string, state: "settled" | "released" | "uncertain"): void {
    this.sql.exec(
      "UPDATE reservations SET state = ?, updated_at = ? WHERE job_id = ? AND state IN ('held', 'uncertain')",
      state,
      this.now(),
      jobId,
    );
  }

  /** Record a remote job about to start and apply blocking budgets to it. */
  begin(input: BeginInput): BeginResult {
    return this.sql.transaction(() => {
      const existing = this.row(input.jobId);
      if (existing) {
        if (existing.status === "rejected" && existing.error_code?.startsWith("BUDGET_")) {
          return {
            ok: false,
            reason:
              existing.error_code === "BUDGET_UNKNOWN_PRICE" ? "unknown_price" : "over_budget",
            message: existing.error_reason ?? "Budget exceeded",
            budgetId: "",
          };
        }
        const held = this.sql.exec<{ amount_usd: number }>(
          "SELECT amount_usd FROM reservations WHERE job_id = ?",
          input.jobId,
        )[0];
        return { ok: true, reservedUsd: held?.amount_usd ?? null };
      }
      const model = safeName(input.modelRequested);
      this.insert({
        id: input.jobId,
        source: input.source,
        client_id: input.clientId ?? null,
        project: input.project ?? null,
        trace_id: input.jobId,
        job_id: input.jobId,
        command: input.command,
        provider: input.provider,
        model_requested: model,
        status: "submitted",
        started_at: input.startedAt,
        provenance: "unknown",
        charge_state: "pending",
      });
      const price = this.rateCard.jobPrice(input.provider, model, input.startedAt);
      const result = this.budgets.preflight(
        input.jobId,
        {
          provider: input.provider,
          model,
          project: input.project ?? null,
          clientId: input.clientId ?? null,
          command: input.command,
        },
        price,
        input.startedAt,
      );
      if (!result.ok) {
        this.update(input.jobId, {
          status: "rejected",
          error_code:
            result.reason === "unknown_price" ? "BUDGET_UNKNOWN_PRICE" : "BUDGET_EXCEEDED",
          error_reason: clip(result.message, 200),
          finished_at: input.startedAt,
          duration_ms: 0,
          charge_state: "no_charge",
          settled: 1,
        });
        this.activities.record({
          actor: input.clientId ?? input.source,
          kind: "budget.blocked",
          target: result.budgetId,
          meta: { jobId: input.jobId, command: input.command, reason: result.reason },
        });
      }
      return result;
    });
  }

  /** A job that never reached the container: no free slot, start refused. */
  release(jobId: string, code: string, reason: string): void {
    this.sql.transaction(() => {
      const row = this.row(jobId);
      if (!row || row.settled) return;
      const at = this.now();
      this.update(jobId, {
        status: "rejected",
        error_code: CODE_RE.test(code) ? code : "NOT_STARTED",
        error_reason: clip(reason, 200),
        finished_at: at,
        duration_ms: Math.max(0, at - row.started_at),
        charge_state: "no_charge",
        settled: 1,
      });
      this.setReservation(jobId, "released");
    });
  }

  /** Record a remote job's final facts once; later calls return the stored event. */
  settle(input: SettleInput): UsageEvent | null {
    return this.sql.transaction(() => {
      let row = this.row(input.jobId);
      if (row?.settled) return toEvent(row, this.adjustmentSum(row.id));
      if (!row) {
        // The begin record is missing (it ran before the ledger existed); keep what the job says.
        this.insert({
          id: input.jobId,
          source: "unknown",
          trace_id: input.jobId,
          job_id: input.jobId,
          command: clip(input.run?.command ?? "unknown", 128),
          provider: clip(input.run?.provider ?? "unknown", 64),
          status: "submitted",
          started_at: input.createdAt,
          provenance: "unknown",
          charge_state: "pending",
        });
        row = this.row(input.jobId) as EventRow;
      }
      const run = input.run;
      const stored = new Map(input.outputs.map((o) => [o.name, o.stored]));
      const outputs: UsageOutput[] = run?.outputs?.length
        ? run.outputs.map((o) => ({
            name: clip(o.name, 200),
            bytes: nonNegative(o.bytes) ?? 0,
            mime: o.mime,
            sha256: o.sha256,
            durationS: nonNegative(o.durationS) ?? undefined,
            stored: stored.get(o.name) ?? false,
          }))
        : input.outputs.map((o) => ({ name: clip(o.name, 200), bytes: o.bytes, stored: o.stored }));
      const usage = usageValues(run?.usage);
      const succeeded = input.status === "succeeded";
      let charge: ChargeState;
      if (succeeded) charge = "charged";
      else if (run) charge = run.http?.requests === 0 ? "no_charge" : "uncertain";
      else if (input.timings) charge = input.timings.cliMs === 0 ? "no_charge" : "uncertain";
      // A container without timings: only its start failures are known not to reach the CLI.
      else if (input.exitCode === null && NOT_STARTED_RE.test(input.error ?? ""))
        charge = "no_charge";
      else charge = "uncertain";
      const reported = nonNegative(run?.usage?.cost_usd);
      let provenance: CostProvenance = "unknown";
      let estimate = null as ReturnType<RateCard["estimate"]>;
      if (reported !== null) provenance = "provider_reported";
      else if (charge !== "no_charge") {
        estimate = this.rateCard.estimate(
          row.provider,
          run?.model ?? row.model_requested,
          row.started_at,
          quantities(usage, outputs, succeeded),
        );
        if (estimate) provenance = "estimated";
      }
      if (reported !== null && charge === "uncertain") charge = "charged";
      const runningAt = input.runningAt ?? null;
      this.update(input.jobId, {
        status: input.status,
        model_resolved: safeName(run?.model),
        error_code: succeeded
          ? null
          : run?.errorCode && CODE_RE.test(run.errorCode)
            ? run.errorCode
            : input.status === "timed_out"
              ? "TIMEOUT"
              : input.status === "canceled"
                ? "CANCELED"
                : "JOB_FAILED",
        error_reason: succeeded || !input.error ? null : clip(sanitizeText(input.error, []), 200),
        running_at: runningAt,
        finished_at: input.finishedAt,
        duration_ms: Math.max(0, input.finishedAt - row.started_at),
        ...outputsValues(outputs),
        provider_ids_json: providerIds(run?.providerIds),
        ...usage,
        actual_cost_usd: reported,
        estimated_cost_usd: estimate?.usd ?? null,
        rate_source: estimate?.source ?? null,
        rate_version: estimate?.version ?? null,
        rate_effective: estimate?.effectiveFrom ?? null,
        provenance,
        charge_state: charge,
        spans_json: JSON.stringify(spans(row.started_at, runningAt, input)),
        http_requests: nonNegative(run?.http?.requests),
        http_errors: nonNegative(run?.http?.errors),
        http_ms: nonNegative(run?.http?.ms),
        settled: 1,
      });
      this.setReservation(
        input.jobId,
        charge === "no_charge"
          ? "released"
          : reported !== null || estimate
            ? "settled"
            : "uncertain",
      );
      if (input.stderrTail && this.debugCaptureUntil() > this.now()) {
        this.sql.exec(
          "INSERT OR REPLACE INTO debug_logs (event_id, text, created_at, expires_at) VALUES (?, ?, ?, ?)",
          input.jobId,
          debugText(input.stderrTail),
          this.now(),
          this.now() + DEBUG_CAPTURE_MS,
        );
      }
      this.budgets.checkAlerts();
      return toEvent(this.row(input.jobId) as EventRow, this.adjustmentSum(input.jobId));
    });
  }

  /** Import runs from `multix history sync`; duplicates (same history id) are counted, not rewritten. */
  importCli(entries: unknown, opts: { project?: string; actor: string }): ImportResult {
    if (!Array.isArray(entries)) throw new UsageInputError("entries must be an array");
    if (entries.length > MAX_IMPORT_ENTRIES) {
      throw new UsageInputError(`at most ${MAX_IMPORT_ENTRIES} entries per request`);
    }
    const result: ImportResult = { accepted: 0, duplicates: 0, rejected: [] };
    this.sql.transaction(() => {
      for (const raw of entries) {
        const entry = (raw ?? {}) as Partial<CliImportEntry>;
        const id = typeof entry.id === "string" ? entry.id : "";
        const reason = this.importProblem(entry);
        if (reason) {
          result.rejected.push({ id: clip(id, 80), reason });
          continue;
        }
        const e = entry as CliImportEntry;
        if (this.row(`cli_${e.id}`)) {
          result.duplicates++;
          continue;
        }
        this.insertCli(e, opts.project);
        result.accepted++;
      }
      if (result.accepted || result.rejected.length) {
        this.activities.record({
          actor: opts.actor,
          kind: "usage.imported",
          meta: {
            accepted: result.accepted,
            duplicates: result.duplicates,
            rejected: result.rejected.length,
            project: opts.project ?? null,
          },
        });
      }
      if (result.accepted) this.budgets.checkAlerts();
    });
    return result;
  }

  private importProblem(e: Partial<CliImportEntry>): string | null {
    if (typeof e.id !== "string" || !HISTORY_ID_RE.test(e.id)) return "invalid id";
    if (typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) return "invalid ts";
    if (typeof e.command !== "string" || !NAME_RE.test(e.command)) return "invalid command";
    if (typeof e.provider !== "string" || !/^[a-z0-9-]{1,64}$/.test(e.provider)) {
      return "invalid provider";
    }
    if (typeof e.ok !== "boolean") return "invalid ok";
    if (!Number.isInteger(e.exit_code)) return "invalid exit_code";
    if (nonNegative(e.duration_ms) === null) return "invalid duration_ms";
    if (e.outputs !== undefined && (!Array.isArray(e.outputs) || e.outputs.length > 100)) {
      return "invalid outputs";
    }
    return null;
  }

  private insertCli(e: CliImportEntry, project: string | undefined): void {
    const startedAt = Date.parse(e.ts);
    const outputs: UsageOutput[] = (e.outputs ?? []).map((o) => ({
      name: typeof o.ext === "string" && EXT_RE.test(o.ext) ? `.${o.ext}` : "",
      bytes: nonNegative(o.bytes) ?? 0,
      mime: typeof o.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(o.mime) ? o.mime : undefined,
      sha256:
        typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : undefined,
      durationS: nonNegative(o.duration_s) ?? undefined,
    }));
    const usage = usageValues(e.usage);
    const http = e.http && typeof e.http === "object" ? e.http : undefined;
    const charge: ChargeState = e.ok
      ? "charged"
      : !http || http.requests === 0
        ? "no_charge"
        : "uncertain";
    const reported = nonNegative(e.usage?.cost_usd);
    const model = safeName(e.model);
    const estimate =
      reported === null && charge !== "no_charge"
        ? this.rateCard.estimate(e.provider, model, startedAt, quantities(usage, outputs, e.ok))
        : null;
    const durationMs = nonNegative(e.duration_ms) ?? 0;
    this.insert({
      id: `cli_${e.id}`,
      source: "cli",
      client_id: "cli",
      project: project ?? null,
      trace_id: `cli_${e.id}`,
      history_id: e.id,
      command: e.command,
      provider: e.provider,
      model_requested: model,
      model_resolved: model,
      status: e.ok ? "succeeded" : "failed",
      error_code: e.ok
        ? null
        : e.error_code && CODE_RE.test(e.error_code)
          ? e.error_code
          : "CLI_FAILED",
      started_at: startedAt,
      finished_at: startedAt + durationMs,
      duration_ms: durationMs,
      ...outputsValues(outputs),
      provider_ids_json: providerIds(e.provider_ids),
      ...usage,
      actual_cost_usd: reported,
      estimated_cost_usd: estimate?.usd ?? null,
      rate_source: estimate?.source ?? null,
      rate_version: estimate?.version ?? null,
      rate_effective: estimate?.effectiveFrom ?? null,
      provenance: reported !== null ? "provider_reported" : estimate ? "estimated" : "unknown",
      charge_state: reported !== null && charge === "uncertain" ? "charged" : charge,
      spans_json: JSON.stringify([{ name: "cli", start: startedAt, end: startedAt + durationMs }]),
      http_requests: nonNegative(http?.requests),
      http_errors: nonNegative(http?.errors),
      http_ms: nonNegative(http?.ms),
      settled: 1,
    });
  }

  adjustmentSum(eventId: string): number {
    return Number(
      this.sql.exec<{ s: number | null }>(
        "SELECT sum(amount_usd) AS s FROM adjustments WHERE event_id = ? AND kind != 'billed'",
        eventId,
      )[0]?.s ?? 0,
    );
  }

  adjustments(eventId: string): Adjustment[] {
    return this.sql
      .exec<{
        id: string;
        event_id: string;
        kind: string;
        amount_usd: number;
        reason: string;
        actor: string;
        created_at: number;
      }>("SELECT * FROM adjustments WHERE event_id = ? ORDER BY created_at", eventId)
      .map((r) => ({
        id: r.id,
        eventId: r.event_id,
        kind: r.kind as AdjustmentKind,
        amountUsd: r.amount_usd,
        reason: r.reason,
        actor: r.actor,
        createdAt: r.created_at,
      }));
  }

  /**
   * Record a refund (amount > 0, subtracted), a signed correction, or the
   * billed amount the provider actually charged (replaces the reported or
   * estimated cost; 0 means the run was not charged).
   */
  adjust(eventId: string, input: unknown, actor: string): Adjustment | null {
    const raw = (input ?? {}) as Record<string, unknown>;
    const kind = raw.kind;
    if (kind !== "refund" && kind !== "correction" && kind !== "billed") {
      throw new UsageInputError("kind must be refund, correction or billed");
    }
    const amount = finite(raw.amountUsd ?? raw.amount_usd);
    if (amount === null || Math.abs(amount) > 100_000) {
      throw new UsageInputError("amountUsd must be a number up to 100000");
    }
    if ((kind === "refund" || kind === "billed") && amount < 0) {
      throw new UsageInputError(`a ${kind} amount cannot be negative`);
    }
    if (kind !== "billed" && amount === 0) throw new UsageInputError("amountUsd cannot be 0");
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (reason.length < 1 || reason.length > 200) {
      throw new UsageInputError("reason must be 1 to 200 characters");
    }
    return this.sql.transaction(() => {
      const row = this.row(eventId);
      if (!row) return null;
      const id = `adj_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const stored = kind === "refund" ? -amount : amount;
      const at = this.now();
      this.sql.exec(
        "INSERT INTO adjustments (id, event_id, kind, amount_usd, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        eventId,
        kind,
        stored,
        clip(sanitizeText(reason, []), 200),
        actor,
        at,
      );
      if (kind === "billed") {
        this.update(eventId, {
          actual_cost_usd: amount,
          provenance: "billed",
          charge_state: amount > 0 ? "charged" : "no_charge",
        });
        this.setReservation(eventId, amount > 0 ? "settled" : "released");
      }
      this.activities.record({
        actor,
        kind: "usage.adjusted",
        target: eventId,
        meta: { adjustment: id, kind, amountUsd: stored },
      });
      this.budgets.checkAlerts();
      return this.adjustments(eventId).find((a) => a.id === id) ?? null;
    });
  }

  debugCaptureUntil(): number {
    const row = this.sql.exec<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'debug_capture_until'",
    )[0];
    return row ? Number(row.value) || 0 : 0;
  }

  /** Turn stderr capture for failed-job debugging on (for 7 days) or off. */
  setDebugCapture(enabled: boolean, actor: string): number {
    return this.sql.transaction(() => {
      const until = enabled ? this.now() + DEBUG_CAPTURE_MS : 0;
      this.sql.exec(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('debug_capture_until', ?)",
        String(until),
      );
      if (!enabled) this.sql.exec("DELETE FROM debug_logs");
      this.activities.record({
        actor,
        kind: enabled ? "debug_capture.enabled" : "debug_capture.disabled",
        meta: enabled ? { until } : {},
      });
      return until;
    });
  }

  /** A captured stderr tail; reading one is itself recorded. */
  readDebugLog(eventId: string, actor: string): string | null {
    return this.sql.transaction(() => {
      const row = this.sql.exec<{ text: string }>(
        "SELECT text FROM debug_logs WHERE event_id = ? AND expires_at > ?",
        eventId,
        this.now(),
      )[0];
      if (!row) return null;
      this.activities.record({ actor, kind: "debug_log.viewed", target: eventId });
      return row.text;
    });
  }

  /** Daily housekeeping: retention, expired debug logs, stale holds. */
  prune(at = this.now()): void {
    this.sql.transaction(() => {
      const cutoff = at - RETENTION_DAYS * DAY;
      this.sql.exec(
        "DELETE FROM adjustments WHERE event_id IN (SELECT id FROM usage_events WHERE started_at < ?)",
        cutoff,
      );
      this.sql.exec(
        "DELETE FROM reservations WHERE job_id IN (SELECT id FROM usage_events WHERE started_at < ?)",
        cutoff,
      );
      this.sql.exec("DELETE FROM usage_events WHERE started_at < ?", cutoff);
      this.sql.exec("DELETE FROM budget_alerts WHERE fired_at < ?", cutoff);
      this.activities.prune(cutoff);
      this.sql.exec("DELETE FROM debug_logs WHERE expires_at <= ?", at);
      this.sql.exec(
        "UPDATE reservations SET state = 'uncertain', updated_at = ? WHERE state = 'held' AND created_at < ?",
        at,
        at - STALE_HOLD_MS,
      );
      this.sql.exec(
        "UPDATE usage_events SET charge_state = 'uncertain', updated_at = ? WHERE settled = 0 AND started_at < ?",
        at,
        at - STALE_HOLD_MS,
      );
    });
  }

  /** Delete every usage record of the account; budgets, the rate card and the activity log stay. */
  deleteUsage(actor: string): number {
    return this.sql.transaction(() => {
      const n = Number(
        this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM usage_events")[0]?.n ?? 0,
      );
      for (const table of [
        "usage_events",
        "adjustments",
        "reservations",
        "debug_logs",
        "budget_alerts",
        "balances",
      ]) {
        this.sql.exec(`DELETE FROM ${table}`);
      }
      this.activities.record({ actor, kind: "usage.deleted", meta: { events: n } });
      return n;
    });
  }
}

/** Queue, inputs, CLI and upload phases of a remote job, from its timings. */
function spans(startedAt: number, runningAt: number | null, input: SettleInput): UsageSpan[] {
  const out: UsageSpan[] = [];
  const t = input.timings;
  const total = t ? t.inputsMs + t.cliMs + t.uploadMs : 0;
  const containerStart = runningAt ?? (t ? Math.max(startedAt, input.finishedAt - total) : null);
  if (containerStart !== null && containerStart > startedAt) {
    out.push({ name: "queue", start: startedAt, end: containerStart });
  }
  if (t && containerStart !== null) {
    let at = containerStart;
    for (const [name, ms] of [
      ["inputs", t.inputsMs],
      ["cli", t.cliMs],
      ["upload", t.uploadMs],
    ] as const) {
      out.push({ name, start: at, end: at + ms });
      at += ms;
    }
  } else {
    out.push({ name: "run", start: containerStart ?? startedAt, end: input.finishedAt });
  }
  return out;
}
