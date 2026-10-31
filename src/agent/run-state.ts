/**
 * State of the single command this CLI process runs: what it called, what it
 * wrote, what the providers reported. One process runs one command, so a
 * module-level record is enough; the agent runtime fills it and turns it into
 * the result envelope and the history entry.
 */

import type { CostPolicy } from "../budget/command-cost.js";
import type { CostEstimate } from "../budget/cost-estimate.js";
import type { ResponseUsage, UsageTokens } from "../core/usage-extract.js";

export interface HttpCall {
  method: string;
  host: string;
  path: string;
  status: number;
  ms: number;
}

export interface RunState {
  startedAt: number;
  argv: string[];
  /** "gemini generate"; empty until commander picked the action. */
  command: string;
  group: string;
  /** Resolved options of the action command (defaults included). */
  options: Record<string, unknown>;
  json: boolean;
  dryRun: boolean;
  verbose: boolean;
  /** Absolute paths written by this process. */
  written: Set<string>;
  calls: HttpCall[];
  /** Requests handed to fetch, counted before they settle (calls[] records them after). */
  requestsStarted: number;
  /** Usage from POST responses (summed) and the latest GET responses (last wins). */
  postUsage: ResponseUsage[];
  getUsage: Map<string, ResponseUsage>;
  /**
   * The run's POST responses report an amount the provider reserves, not one
   * it charged (Sume refunds a submit's usage when the job fails or is
   * canceled): they stay in metrics but never count as cost or credits. The
   * charge comes from a later read of the job.
   */
  postAmountsReserved?: boolean;
  ids: string[];
  /** Index in calls[] of the response that first returned each id in ids. */
  idCalls: Map<string, number>;
  /** Programs started for paid work outside fetch (the Codex image driver). */
  externalRuns: string[];
  /** Model named by the first provider request that names one. */
  requestModel?: string;
  /** Model the first provider response that reports one names as served (alias or route resolved). */
  resolvedModel?: string;
  /** Structured result a command reports for the envelope's `data` (wins over parsed stdout). */
  data?: unknown;
  /** stdout/stderr text captured in JSON mode. */
  stdout: string[];
  stderr: string[];
  /** Last error line a command logged before exiting. */
  lastErrorLine?: string;
  /** Pre-flight estimate (`--estimate`, `--max-cost`, or a priceable command). */
  estimate?: CostEstimate;
  maxCost?: number;
  costPolicy?: CostPolicy;
  /**
   * `--text-file` (or `fish tts --turns-file`) as read by the pre-flight
   * estimate, without a leading BOM; the command speaks this same text so a
   * file changed in between cannot exceed a proven ceiling.
   */
  textFile?: { path: string; text: string };
  /** Outcome of the --max-cost check. */
  budget?: {
    ok: boolean;
    max_cost_usd: number;
    policy: CostPolicy;
    code?: string;
    message?: string;
  };
  /**
   * A paid provider job this run submitted that keeps running if the run is
   * stopped (an Atlas Cloud prediction being polled): a run cancelled by a
   * signal reports how to resume it instead of a rerun that would pay twice.
   */
  inFlight?: { id: string; resume: string };
  /** A job the command named itself (a read of a job given on the command line). */
  namedJob?: string;
  /**
   * What a signal left behind, recorded by the handler of a phase that knows better
   * than request counting: an upload before submit billed nothing, while a submit
   * still in flight may have been accepted under an id the run never saw.
   */
  interrupted?: { hint: string; retryable: boolean };
  /**
   * Set by a command that saved part of its outputs before a later paid request
   * failed: the option changes that request only what is still missing (null
   * drops an option, such as an --output already written). The failure suggests
   * that run instead of a rerun that pays again for the saved files.
   */
  partial?: { options: Record<string, string | null> };
  /** True once a command action started (help and parse errors never get there). */
  actionStarted: boolean;
  finalized: boolean;
}

export const run: RunState = {
  startedAt: Date.now(),
  argv: [],
  command: "",
  group: "",
  options: {},
  json: false,
  dryRun: false,
  verbose: false,
  written: new Set(),
  calls: [],
  requestsStarted: 0,
  postUsage: [],
  getUsage: new Map(),
  ids: [],
  idCalls: new Map(),
  externalRuns: [],
  stdout: [],
  stderr: [],
  actionStarted: false,
  finalized: false,
};

/** Record a submitted job that keeps running if the run stops; its id goes in provider_ids. */
export function trackInFlight(id: string, resume: string, state: RunState = run): void {
  state.inFlight = { id, resume };
  if (!state.ids.includes(id)) state.ids.unshift(id);
}

/**
 * Name the job a command acts on when its responses may not carry the id (a
 * result read), so the run joins that job's operation; its id goes in provider_ids.
 */
export function nameJob(given: string, state: RunState = run): void {
  // Clients trim the id they send, so name the job by the same trimmed form.
  const id = given.trim();
  // Same bound as an id read from a response: a longer argument is not a job id.
  if (!id || id.length > 128) return;
  state.namedJob = id;
  if (!state.ids.includes(id)) state.ids.unshift(id);
}

export interface UsageSummary {
  tokens?: UsageTokens;
  cost_usd?: number;
  credits?: number;
  /** Where each provider reported cost_usd / credits ("<host> header.<name>" or "<host> body.<path>"). */
  sources?: { cost_usd?: string[]; credits?: string[] };
  /** Provider-reported numbers by key path (polls: last value; creates: summed). */
  metrics?: Record<string, number>;
}

function addTokens(into: UsageTokens, from: UsageTokens): void {
  for (const key of ["input", "output", "total", "thinking"] as const) {
    const v = from[key];
    if (v !== undefined) into[key] = (into[key] ?? 0) + v;
  }
}

export interface JobIdentity {
  provider: string;
  id: string;
  /** 1, or one more per failed send of the same request before the one that returned the id. */
  attempt: number;
}

/** Upload endpoints: the id they return names an input file, not the job. */
const UPLOAD_PATH = /upload|\/(files|assets)(\/|$)/i;

/** A call whose returned id can name the job: it succeeded and is not an upload (a GET only when `submit` is false). */
export function namesJob(call: HttpCall | undefined, submit: boolean): boolean {
  if (!call || call.status === 0 || call.status >= 400 || UPLOAD_PATH.test(call.path)) return false;
  return !submit || call.method !== "GET";
}

/**
 * The provider job or request this run is about: the in-flight job when one
 * was tracked, else the job the command named, else the first id a successful submit (non-GET, not an upload)
 * returned, else the first id a successful GET returned. Ids from failed calls
 * stay in provider_ids but never name the job.
 */
export function jobIdentity(state: RunState = run): JobIdentity | undefined {
  if (!state.group) return undefined;
  const ok = (id: string, submit: boolean) =>
    namesJob(state.calls[state.idCalls.get(id) ?? -1], submit);
  const id =
    state.inFlight?.id ??
    state.namedJob ??
    state.ids.find((i) => ok(i, true)) ??
    state.ids.find((i) => ok(i, false));
  if (!id) return undefined;
  const at = state.idCalls.get(id) ?? -1;
  const call = state.calls[at];
  // Only a failed send of the same submit before it is a retry; failed polls resubmit nothing.
  const failedBefore =
    call && call.method !== "GET"
      ? state.calls
          .slice(0, at)
          .filter(
            (c) =>
              c.method === call.method &&
              c.host === call.host &&
              c.path === call.path &&
              (c.status === 0 || c.status >= 400),
          ).length
      : 0;
  return { provider: state.group, id, attempt: 1 + failedBefore };
}

/** Combine every response's usage into one summary. */
export function summarizeUsage(state: RunState = run): UsageSummary | undefined {
  const records = [...state.postUsage, ...state.getUsage.values()];
  if (records.length === 0) return undefined;
  const tokens: UsageTokens = {};
  const metrics: Record<string, number> = {};
  let cost: number | undefined;
  let credits: number | undefined;
  // A GET status read of the same job or generation reports the final charge, so
  // the estimate on the POST that started it is not counted a second time.
  const gets = [...state.getUsage.values()];
  const charged = {
    cost_usd: new Set(gets.filter((r) => r.cost_usd !== undefined).flatMap((r) => r.ids)),
    credits: new Set(gets.filter((r) => r.credits !== undefined).flatMap((r) => r.ids)),
  };
  const sources: { cost_usd?: string[]; credits?: string[] } = {};
  for (const [i, r] of records.entries()) {
    const isPost = i < state.postUsage.length;
    const settled = (key: "cost_usd" | "credits") =>
      isPost && (state.postAmountsReserved === true || r.ids.some((id) => charged[key].has(id)));
    for (const key of ["cost_usd", "credits"] as const) {
      const src = r.sources?.[key];
      if (src && r[key] !== undefined && !settled(key) && !sources[key]?.includes(src)) {
        sources[key] = [...(sources[key] ?? []), src];
      }
    }
    addTokens(tokens, r.tokens);
    if (r.cost_usd !== undefined && !settled("cost_usd")) cost = (cost ?? 0) + r.cost_usd;
    if (r.credits !== undefined && !settled("credits")) credits = (credits ?? 0) + r.credits;
    for (const [k, v] of Object.entries(r.metrics)) {
      metrics[k] = isPost && metrics[k] !== undefined ? (metrics[k] ?? 0) + v : v;
    }
  }
  const summary: UsageSummary = {};
  if (Object.keys(tokens).length > 0) summary.tokens = tokens;
  if (cost !== undefined) summary.cost_usd = Math.round(cost * 1e6) / 1e6;
  if (credits !== undefined) summary.credits = credits;
  if (Object.keys(sources).length > 0) summary.sources = sources;
  if (Object.keys(metrics).length > 0) summary.metrics = metrics;
  return Object.keys(summary).length > 0 ? summary : undefined;
}
