/**
 * Shapes of the usage ledger (one per account, usage/account-usage.ts):
 * usage events, budgets, activities, the rate card and provider balances.
 *
 * Money is USD. A cost nobody measured is `null`, never 0: `provenance`
 * says where a number came from, `charge_state` whether the provider may
 * have charged at all.
 */

export const USAGE_SCHEMA_VERSION = 1;

/** Where a run came from: the MCP server, the REST API, a CLI history import. */
export type UsageSource = "mcp" | "rest" | "cli" | "unknown";
export const USAGE_SOURCES: readonly UsageSource[] = ["mcp", "rest", "cli", "unknown"];

export type UsageStatus =
  | "submitted"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled"
  /** Never reached a provider: budget block, no free job slot, container refused. */
  | "rejected";
export const USAGE_STATUSES: readonly UsageStatus[] = [
  "submitted",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "rejected",
];

/** Where a cost number comes from. */
export type CostProvenance = "provider_reported" | "estimated" | "billed" | "unknown";

/**
 * Whether the provider may have charged: `charged` (the run reached the
 * provider and finished), `uncertain` (it reached the provider but ended in
 * failure, timeout or cancel: it may or may not be billed), `no_charge` (it
 * never reached a provider), `pending` (still running).
 */
export type ChargeState = "charged" | "uncertain" | "no_charge" | "pending";

export interface UsageOutput {
  /** File name for remote jobs; extension only for CLI imports. */
  name: string;
  bytes: number;
  mime?: string;
  sha256?: string;
  durationS?: number;
  /** Stored in the account's R2 bucket (remote jobs). */
  stored?: boolean;
}

export interface UsageSpan {
  name: string;
  start: number;
  end: number;
}

export interface UsageEvent {
  id: string;
  schemaVersion: number;
  source: UsageSource;
  clientId: string | null;
  project: string | null;
  traceId: string;
  jobId: string | null;
  historyId: string | null;
  command: string;
  provider: string;
  modelRequested: string | null;
  modelResolved: string | null;
  attempt: number;
  status: UsageStatus;
  errorCode: string | null;
  errorReason: string | null;
  startedAt: number;
  runningAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  outputCount: number | null;
  outputBytes: number | null;
  outputs: UsageOutput[];
  providerIds: string[];
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensTotal: number | null;
  tokensThinking: number | null;
  characters: number | null;
  audioSeconds: number | null;
  credits: number | null;
  creditsUnit: string | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  /** Sum of refunds and corrections recorded against this event. */
  adjustmentUsd: number;
  currency: "USD";
  rateSource: string | null;
  rateVersion: string | null;
  rateEffective: string | null;
  provenance: CostProvenance;
  chargeState: ChargeState;
  metrics: Record<string, number>;
  spans: UsageSpan[];
  httpRequests: number | null;
  httpErrors: number | null;
  httpMs: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Provider usage as the CLI measured it (src/agent/run-state.ts UsageSummary). */
export interface RunUsage {
  tokens?: { input?: number; output?: number; total?: number; thinking?: number };
  cost_usd?: number;
  credits?: number;
  metrics?: Record<string, number>;
}

/** What the Worker knows when a job is about to start. */
export interface BeginInput {
  jobId: string;
  source: UsageSource;
  clientId?: string;
  project?: string;
  /** Normalised command path, e.g. `gemini image`. */
  command: string;
  /** Command group, which names the provider (`gemini`). */
  provider: string;
  modelRequested?: string;
  startedAt: number;
}

export type BeginResult =
  | { ok: true; reservedUsd: number | null }
  | { ok: false; reason: "over_budget" | "unknown_price"; message: string; budgetId: string };

/** The final facts of a remote job, sent by its Durable Object (no URLs, no stdout). */
export interface SettleInput {
  jobId: string;
  status: "succeeded" | "failed" | "timed_out" | "canceled";
  createdAt: number;
  runningAt?: number;
  finishedAt: number;
  /** Fixed Worker/container wording, never CLI output. */
  error?: string;
  exitCode: number | null;
  outputs: Array<{ name: string; bytes: number; stored: boolean }>;
  timings?: { inputsMs: number; cliMs: number; uploadMs: number };
  run?: {
    command: string;
    provider: string;
    model?: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    errorCode?: string;
    usage?: RunUsage;
    http?: { requests: number; errors: number; ms: number };
    providerIds?: string[];
    outputs?: Array<{
      name: string;
      bytes: number;
      mime?: string;
      sha256?: string;
      durationS?: number;
    }>;
  };
  /** Redacted stderr tail; stored only while the account has debug capture on. */
  stderrTail?: string;
}

/** One entry of `multix history sync` (CLI side: src/commands/agent/history-sync.ts). */
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
  usage?: RunUsage;
  http?: { requests: number; errors: number; ms: number };
  provider_ids?: string[];
}

export interface ImportResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ id: string; reason: string }>;
}

export type BudgetScope = "account" | "project" | "provider" | "model" | "client" | "task";
export const BUDGET_SCOPES: readonly BudgetScope[] = [
  "account",
  "project",
  "provider",
  "model",
  "client",
  "task",
];
export type BudgetPeriod = "day" | "week" | "month" | "custom";
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["day", "week", "month", "custom"];
/** `alert` only reports; `block` also refuses new Multix jobs that would exceed the limit. */
export type BudgetMode = "alert" | "block";
/** What a blocking budget does with a job whose price is unknown before it runs. */
export type UnknownPricePolicy = "block" | "allow";

export interface BudgetInput {
  name: string;
  scope: BudgetScope;
  /** Required unless scope is `account`. */
  scopeValue?: string;
  period: BudgetPeriod;
  /** Custom window (epoch ms), required for `custom`. */
  windowStart?: number;
  windowEnd?: number;
  limitUsd: number;
  mode: BudgetMode;
  /** USD held per job while it runs when the rate card has no per-job price. */
  reserveUsd?: number;
  unknownPrice: UnknownPricePolicy;
  /** Alert thresholds in percent (default 50, 80, 100). */
  thresholds?: number[];
}

export interface Budget
  extends Required<Omit<BudgetInput, "scopeValue" | "windowStart" | "windowEnd" | "reserveUsd">> {
  id: string;
  scopeValue: string | null;
  windowStart: number | null;
  windowEnd: number | null;
  reserveUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BudgetStatus {
  budget: Budget;
  window: { start: number; end: number };
  /** Provider-reported and billed USD in the window, adjustments included. */
  actualUsd: number;
  /** Rate-card estimates for runs without a reported cost. */
  estimatedUsd: number;
  /** USD held for running jobs and for finished runs whose charge is uncertain. */
  heldUsd: number;
  /** actual + estimated + held: what the limit is compared with. */
  committedUsd: number;
  /** Runs in scope that may have cost money but have no known or estimated price. */
  unknownRuns: number;
  percent: number;
  /** Linear burn-rate projection to the end of the window; a forecast, not a bill. */
  forecastUsd: number | null;
  /** Thresholds already crossed in this window. */
  crossed: number[];
}

export interface ActivityInput {
  /** `dashboard:<userId>`, `api_key:<keyId>`, `mcp:<clientId>`, `system`. */
  actor: string;
  kind: string;
  target?: string;
  /** Safe metadata only: names, ids, counts. Never key values, prompts or URLs. */
  meta?: Record<string, string | number | boolean | null>;
}

export interface Activity extends Required<Omit<ActivityInput, "target" | "meta">> {
  seq: number;
  ts: number;
  target: string | null;
  meta: Record<string, string | number | boolean | null>;
  hash: string;
}

export type RateUnit =
  | "job"
  | "output"
  | "output_second"
  | "1k_input_tokens"
  | "1k_output_tokens"
  | "credit";
export const RATE_UNITS: readonly RateUnit[] = [
  "job",
  "output",
  "output_second",
  "1k_input_tokens",
  "1k_output_tokens",
  "credit",
];

export interface RateCardEntry {
  provider: string;
  /** `*` matches every model of the provider. */
  model: string;
  unit: RateUnit;
  usd: number;
  /** ISO date (YYYY-MM-DD) the price applies from. */
  effectiveFrom: string;
  /** Free-form label of where the price came from, e.g. a pricing page date. */
  version: string;
}

export type BalanceKind = "cash" | "credits" | "subscription_quota";

export interface ProviderBalance {
  provider: string;
  status: "ok" | "no_key" | "unsupported" | "forbidden" | "error";
  checkedAt: number;
  kind: BalanceKind | null;
  unit: string | null;
  remaining: number | null;
  used: number | null;
  limit: number | null;
  detail: string | null;
}

/** Filters shared by summaries, event lists and exports. */
export interface UsageFilter {
  from: number;
  to: number;
  provider?: string;
  model?: string;
  source?: UsageSource;
  project?: string;
  client?: string;
  status?: UsageStatus;
  command?: string;
  /** Substring of command, model, provider or error code. */
  q?: string;
}

export interface UsageKpis {
  jobs: number;
  succeeded: number;
  failed: number;
  rejected: number;
  successRate: number | null;
  actualUsd: number;
  estimatedUsd: number;
  adjustmentsUsd: number;
  /** actual + estimated + adjustments. */
  knownUsd: number;
  unknownCostRuns: number;
  uncertainRuns: number;
  credits: number | null;
  outputs: number;
  outputBytes: number;
  /** knownUsd / outputs of succeeded runs that have a known cost. */
  costPerOutputUsd: number | null;
  costPerSucceededRunUsd: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  httpRequests: number;
  httpErrors: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface UsageBucket {
  key: string;
  start: number;
  jobs: number;
  succeeded: number;
  knownUsd: number;
  estimatedUsd: number;
  unknownCostRuns: number;
  credits: number;
}

export interface UsageBreakdownRow {
  key: string;
  jobs: number;
  succeeded: number;
  knownUsd: number;
  unknownCostRuns: number;
  credits: number;
  outputs: number;
  avgMs: number | null;
}

export interface UsageSummary {
  filter: UsageFilter;
  bucket: "hour" | "day" | "week";
  tzOffsetMinutes: number;
  kpis: UsageKpis;
  series: UsageBucket[];
  breakdown: Record<
    "provider" | "model" | "source" | "command" | "client" | "project" | "status",
    UsageBreakdownRow[]
  >;
}
