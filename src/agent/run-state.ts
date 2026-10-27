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
  ids: string[];
  /** Programs started for paid work outside fetch (the Codex image driver). */
  externalRuns: string[];
  /** Model named by the first provider request that names one. */
  requestModel?: string;
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
  externalRuns: [],
  stdout: [],
  stderr: [],
  actionStarted: false,
  finalized: false,
};

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
      isPost && r.ids.some((id) => charged[key].has(id));
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
