/**
 * Records of the per-account usage ledger (ledger/usage-ledger.ts): one
 * operation per job or imported CLI run, cost adjustments, budgets and the
 * activity log. Wire shapes use snake_case like the rest of the REST API.
 *
 * Unknown is null, never 0: a cost, token count or credit amount the provider
 * did not report stays null, and totals count those operations separately.
 */

export const LEDGER_SCHEMA_VERSION = 1;

export type OperationSource = "mcp" | "rest" | "cli" | "unknown";
export const OPERATION_SOURCES: readonly OperationSource[] = ["mcp", "rest", "cli", "unknown"];

export type OperationStatus = "running" | "succeeded" | "failed" | "timed_out" | "canceled";
export const OPERATION_STATUSES: readonly OperationStatus[] = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
];

/**
 * Where a cost number comes from. `provider_reported`: the provider's own
 * response said so; `estimated`: multix computed it from a rate table;
 * `billed`: reconciled against an invoice; `unknown`: nothing reported.
 */
export type CostProvenance = "estimated" | "provider_reported" | "billed" | "unknown";

export interface OperationSpan {
  name: string;
  start: number;
  end: number;
}

export interface OperationOutput {
  name?: string;
  bytes: number;
  mime?: string;
  sha256?: string;
  duration_s?: number;
}

/** Bounded details kept as JSON next to the indexed columns. */
export interface OperationDetail {
  provider_ids?: string[];
  outputs?: OperationOutput[];
  spans?: OperationSpan[];
  metrics?: Record<string, number>;
  /** Short safe reason for a failure outside the CLI (container, upload, timeout). */
  error?: string;
  cli_version?: string;
}

export interface Operation {
  op_id: string;
  schema_version: number;
  source: OperationSource;
  client_id: string | null;
  client_name: string | null;
  project_id: string | null;
  trace_id: string;
  job_id: string | null;
  history_id: string | null;
  command: string;
  provider: string;
  model: string | null;
  task: string | null;
  status: OperationStatus;
  error_code: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  output_count: number | null;
  output_bytes: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  tokens_thinking: number | null;
  credits: number | null;
  credits_unit: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  currency: "USD";
  cost_provenance: CostProvenance;
  rate_source: string | null;
  http_requests: number | null;
  http_errors: number | null;
  detail: OperationDetail;
  updated_at: number;
}

/** What a caller supplies; the ledger fills schema_version, currency and updated_at. */
export type OperationInput = Omit<Operation, "schema_version" | "currency" | "updated_at">;

export type AdjustmentKind = "refund" | "correction";

export interface Adjustment {
  id: string;
  op_id: string;
  kind: AdjustmentKind;
  /** Signed USD amount added to the operation's cost (a refund is negative). */
  amount_usd: number;
  note: string | null;
  actor: string;
  created_at: number;
}

export type BudgetScopeKind =
  | "account"
  | "provider"
  | "model"
  | "command"
  | "source"
  | "client"
  | "project";
export const BUDGET_SCOPE_KINDS: readonly BudgetScopeKind[] = [
  "account",
  "provider",
  "model",
  "command",
  "source",
  "client",
  "project",
];

export type BudgetPeriod = "day" | "week" | "month";
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["day", "week", "month"];

export interface Budget {
  id: string;
  name: string;
  scope_kind: BudgetScopeKind;
  /** Null for the account scope. */
  scope_value: string | null;
  period: BudgetPeriod;
  limit_usd: number;
  /** Percentages that raise an alert once per period, e.g. [50, 80, 100]. */
  thresholds: number[];
  created_at: number;
  updated_at: number;
}

export type BudgetInput = Pick<
  Budget,
  "name" | "scope_kind" | "scope_value" | "period" | "limit_usd" | "thresholds"
>;

export interface BudgetStatus extends Budget {
  period_start: number;
  period_end: number;
  /** Known cost in the period: provider-reported + estimated + adjustments. */
  spent_usd: number;
  /** Operations in scope whose cost is unknown (spent_usd may be low). */
  unknown_cost_operations: number;
  percent: number;
  /** Linear projection of spent_usd to the period end; a forecast, not a bill. */
  forecast_usd: number | null;
  state: "ok" | "warning" | "exceeded";
  /** Thresholds already crossed in this period. */
  alerts: number[];
}

export interface Activity {
  seq: number;
  id: string;
  ts: number;
  actor: string;
  kind: string;
  subject: string | null;
  metadata: Record<string, string | number | boolean | null>;
  prev_hash: string;
  hash: string;
}

export type ActivityInput = Pick<Activity, "actor" | "kind" | "subject" | "metadata"> & {
  ts?: number;
};

export interface OperationFilter {
  from?: number;
  to?: number;
  provider?: string;
  model?: string;
  source?: OperationSource;
  status?: OperationStatus;
  command?: string;
  client_id?: string;
  project_id?: string;
}

export type GroupBy = "provider" | "model" | "source" | "command" | "status" | "client" | "project";
export const GROUP_BYS: readonly GroupBy[] = [
  "provider",
  "model",
  "source",
  "command",
  "status",
  "client",
  "project",
];

export interface UsageTotals {
  operations: number;
  succeeded: number;
  failed: number;
  running: number;
  /** succeeded / finished operations; null when none finished. */
  success_rate: number | null;
  provider_reported_cost_usd: number;
  estimated_cost_usd: number;
  adjustments_usd: number;
  /** provider-reported + estimated + adjustments. */
  known_cost_usd: number;
  unknown_cost_operations: number;
  credits: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  output_count: number;
  output_bytes: number;
  http_errors: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  /** known_cost_usd / outputs of succeeded operations; null when unknown costs or no outputs. */
  cost_per_successful_output_usd: number | null;
}

export interface UsageSummary {
  from: number;
  to: number;
  tz_offset_minutes: number;
  totals: UsageTotals;
  group_by: GroupBy | null;
  groups: Array<{ key: string | null } & UsageTotals>;
  series: Array<{
    bucket_start: number;
    operations: number;
    failed: number;
    known_cost_usd: number;
    unknown_cost_operations: number;
  }>;
}
