/**
 * Pull measurement data out of provider responses (runtime-neutral). Every
 * provider reports usage differently (Gemini usageMetadata, OpenAI/OpenRouter
 * usage, Replicate/fal metrics, Leonardo apiCreditCost, Runway cost, MiniMax
 * extra_info, ElevenLabs character-cost header, ...), so besides the known
 * shapes this keeps any numeric leaf whose key names a token, cost, credit,
 * usage, duration or timing value. It never keeps strings other than ids.
 */

export interface UsageTokens {
  input?: number;
  output?: number;
  total?: number;
  thinking?: number;
}

export interface ResponseUsage {
  tokens: UsageTokens;
  /** USD reported by the provider (e.g. OpenRouter usage.cost). */
  cost_usd?: number;
  /** Provider credits consumed (Leonardo, Runway, HeyGen, ...). */
  credits?: number;
  /** Flattened numeric fields worth keeping, by key path. */
  metrics: Record<string, number>;
  /** Job / request ids the provider returned. */
  ids: string[];
  /** Where cost_usd / credits came from ("body.<key path>" or "header.<name>"). */
  sources?: UsageSources;
}

/** Provenance of the reported money numbers, so they are never mistaken for estimates. */
export interface UsageSources {
  cost_usd?: string;
  credits?: string;
}

const METRIC_KEY =
  /(token|cost|credit|price|usage|billing|duration|seconds|_time$|^time$|time_ms|latency|characters?_?(count|cost)|units?$|predict|inference)/i;
const SKIP_KEY =
  /(_at$|stamp|date|created|updated|expire|limit|max_|min_|width|height|seed|fps|index|count_?max)/i;
/**
 * Keys that name what an account holds, not what a request spent: Leonardo /me
 * user_details[].apiCredit, TopView remainCredit, HeyGen /v3/users/me usage_based.remaining_credits /
 * included_credits, generic balance fields. Leaves match by name; the parents
 * match whole segments so a spend leaf under e.g. subscription_job still counts.
 */
const BALANCE_LEAF =
  /(balance|remain|available|allowance|included|quota|granted|purchased|unused|left|^api_?credits?$)/i;
const BALANCE_PARENT = /^(wallet|subscription|user_details|balances?)$/i;
/** Parents of account totals, never a spend of this request (TopView apiKeyMap[].costCredit). */
const ACCOUNT_TOTALS_PARENT = /^api_?key_?map$/i;
/**
 * Words that make a leaf a spend even when it also names a balance
 * (quota_credits_used, includedCreditsSpent, subscription.credits_used). Matched
 * as whole words of the snake_case or camelCase key, so unused_credits stays a balance.
 */
const SPEND_WORDS = new Set(["used", "spent", "consumed", "cost", "charged"]);

function leafWords(leaf: string): string[] {
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

/**
 * "plain": a spend key; "balance": what an account holds, never a spend;
 * "spend-in-balance": a spend word inside a balance name or parent, which counts
 * only when the response has no plain spend key (a job's credits beat a
 * subscription's credits_used).
 */
type PathKind = "plain" | "balance" | "spend-in-balance";

function pathKind(path: string): PathKind {
  const segments = path.split(".").map((segment) => segment.replace(/\[\d+\]$/, ""));
  const leaf = segments.pop() ?? "";
  if (segments.some((segment) => ACCOUNT_TOTALS_PARENT.test(segment))) return "balance";
  const balance =
    BALANCE_LEAF.test(leaf) || segments.some((segment) => BALANCE_PARENT.test(segment));
  if (!balance) return "plain";
  return leafWords(leaf).some((word) => SPEND_WORDS.has(word)) ? "spend-in-balance" : "balance";
}
/** Key paths that name a forecast, not a charge (Runway estimatedCost, quotes). */
const ESTIMATE_PATH = /(estimat|quote|expected)/i;
const ID_KEYS = new Set([
  "id",
  "request_id",
  "requestId",
  "task_id",
  "taskId",
  "generation_id",
  "generationId",
  "prediction_id",
  "video_id",
  "job_id",
  "jobId",
  // Gemini generateContent names its response here.
  "responseId",
]);
const USAGE_HEADERS = [
  "x-request-id",
  "request-id",
  "x-amzn-requestid",
  // OpenRouter names the generation of an audio call (no JSON id) here.
  "x-generation-id",
  "character-cost",
  "x-character-count",
  "openai-processing-ms",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
];
const MAX_METRICS = 40;
const MAX_DEPTH = 5;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = num(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Known token shapes: Gemini usageMetadata and Interactions usage, OpenAI/OpenRouter/BytePlus usage. */
function tokensFrom(body: Record<string, unknown>, into: UsageTokens): void {
  const gemini = asRecord(body.usageMetadata) ?? asRecord(body.usage_metadata);
  if (gemini) {
    into.input = pick(gemini, "promptTokenCount", "prompt_token_count") ?? into.input;
    into.output = pick(gemini, "candidatesTokenCount", "candidates_token_count") ?? into.output;
    into.total = pick(gemini, "totalTokenCount", "total_token_count") ?? into.total;
    into.thinking = pick(gemini, "thoughtsTokenCount", "thoughts_token_count") ?? into.thinking;
  }
  const usage = asRecord(body.usage);
  if (usage) {
    into.input =
      pick(
        usage,
        "prompt_tokens",
        "input_tokens",
        "promptTokens",
        "inputTokens",
        "total_input_tokens",
      ) ?? into.input;
    into.output =
      pick(
        usage,
        "completion_tokens",
        "output_tokens",
        "completionTokens",
        "outputTokens",
        "total_output_tokens",
      ) ?? into.output;
    into.total = pick(usage, "total_tokens", "totalTokens") ?? into.total;
    const details =
      asRecord(usage.completion_tokens_details) ?? asRecord(usage.output_tokens_details);
    if (details) into.thinking = pick(details, "reasoning_tokens") ?? into.thinking;
  }
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  out: ResponseUsage,
  collectIds = true,
): void {
  if (depth > MAX_DEPTH || Object.keys(out.metrics).length >= MAX_METRICS) return;
  if (Array.isArray(value)) {
    // Arrays of outputs/images rarely carry usage; look at the first few only.
    // Ids in a list of several items name catalog entries (e.g. GET /models), not this request.
    const ids = collectIds && value.length === 1;
    value.slice(0, 3).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1, out, ids));
    return;
  }
  const obj = asRecord(value);
  if (!obj) return;
  for (const [key, child] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    const n = num(child);
    if (n !== undefined) {
      const inUsageObject = /usage|metrics|billing|extra_info/i.test(path);
      if ((METRIC_KEY.test(key) || inUsageObject) && !SKIP_KEY.test(key)) {
        out.metrics[childPath] = n;
      }
    } else if (
      collectIds &&
      depth <= 2 &&
      ID_KEYS.has(key) &&
      typeof child === "string" &&
      child.length > 0 &&
      child.length <= 128 &&
      !out.ids.includes(child)
    ) {
      if (out.ids.length < 5) out.ids.push(child);
    } else if (child && typeof child === "object") {
      walk(child, childPath, depth + 1, out, collectIds);
    }
  }
}

const SUME_JOB_ID = /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** usage_summary states in which Sume has settled the job: captured, or refunded in full. */
const SUME_SETTLED = new Set(["captured", "refunded"]);

/**
 * Sume (api.sume.com) job responses, wrapped in `data`, carry money in three
 * places, only two of which are a charge:
 * - submit: `data.usage.usd` (decimal string, the charge reserved for this
 *   job) and `data.usage.credits`; a replay (`idempotency_hit: true`) charged
 *   nothing new;
 * - a settled `usage_summary` (on a status read, the full job or a cancel):
 *   `captured_usd_cents` is what the job finally cost, 0 once refunded;
 * - reserved/released/refunded amounts and a still-reserved summary, which
 *   are never spend.
 * Returns undefined for other bodies; otherwise replaces whatever the generic
 * walk picked as cost or credits (it would take reserved_credits).
 */
function sumeMoney(
  body: Record<string, unknown>,
): Pick<ResponseUsage, "cost_usd" | "credits" | "sources"> | undefined {
  const data = asRecord(body.data);
  if (!data) return undefined;
  const job = asRecord(data.job);
  const id = [data.job_id, job?.id, data.id, data.request_id].find(
    (v) => typeof v === "string" && SUME_JOB_ID.test(v),
  );
  const isSume =
    id !== undefined &&
    ("sume_status" in data || "idempotency_hit" in data || "usage_summary" in data || !!job);
  if (!isSume) return undefined;
  const out: Pick<ResponseUsage, "cost_usd" | "credits" | "sources"> = {};
  const usage = asRecord(data.usage);
  const usd = typeof usage?.usd === "string" ? usage.usd.trim() : undefined;
  if (usage && data.idempotency_hit !== true && usd && /^\d+(\.\d+)?$/.test(usd)) {
    out.cost_usd = Number(usd);
    out.sources = { cost_usd: "body.data.usage.usd" };
    const credits = num(usage.credits);
    if (credits !== undefined) {
      out.credits = credits;
      out.sources.credits = "body.data.usage.credits";
    }
    return out;
  }
  // A result read repeats the job's summary next to the status read: count it once.
  if (data.result !== undefined) return out;
  const summaryPath = asRecord(data.usage_summary)
    ? "data.usage_summary"
    : "data.job.usage_summary";
  const summary = asRecord(data.usage_summary) ?? asRecord(job?.usage_summary);
  const status = typeof summary?.status === "string" ? summary.status.toLowerCase() : "";
  if (summary && (summary.final === true || SUME_SETTLED.has(status))) {
    const cents = num(summary.captured_usd_cents) ?? (status === "refunded" ? 0 : undefined);
    if (cents !== undefined) {
      out.cost_usd = Math.round(cents) / 100;
      out.sources = { cost_usd: `body.${summaryPath}.captured_usd_cents` };
    }
    const credits = num(summary.captured_credits);
    if (credits !== undefined) {
      out.credits = credits;
      out.sources = { ...out.sources, credits: `body.${summaryPath}.captured_credits` };
    }
  }
  return out;
}

/**
 * TopView API Platform predictions (`{code, data}`) report `data.charged_usd`,
 * a decimal string. It is the charge only once `billing_state` is CAPTURED;
 * RELEASED returns the whole hold (0) and RESERVED is a hold, not spend.
 * Returns undefined for other bodies.
 */
function topviewPlatformMoney(
  body: Record<string, unknown>,
): Pick<ResponseUsage, "cost_usd" | "credits" | "sources"> | undefined {
  const data = asRecord(body.data);
  const charged = typeof data?.charged_usd === "string" ? data.charged_usd.trim() : undefined;
  const state = typeof data?.billing_state === "string" ? data.billing_state.toUpperCase() : "";
  if (!data || charged === undefined || !state) return undefined;
  if (state === "RELEASED")
    return { cost_usd: 0, sources: { cost_usd: "body.data.billing_state" } };
  if (state === "CAPTURED" && /^\d+(\.\d+)?$/.test(charged)) {
    return { cost_usd: Number(charged), sources: { cost_usd: "body.data.charged_usd" } };
  }
  return {};
}

/** Extract usage from one parsed JSON response body and its headers. */
export function extractUsage(body: unknown, headers?: Headers | null): ResponseUsage {
  const out: ResponseUsage = { tokens: {}, metrics: {}, ids: [] };
  const obj = asRecord(body);
  if (obj) {
    tokensFrom(obj, out.tokens);
    walk(obj, "", 0, out);
  }
  const providerMoney = obj ? (sumeMoney(obj) ?? topviewPlatformMoney(obj)) : undefined;
  for (const kind of providerMoney ? [] : (["plain", "spend-in-balance"] as const)) {
    for (const [path, value] of Object.entries(out.metrics)) {
      const leaf = path.split(".").pop() ?? path;
      // Balances never count; a spend inside a balance counts only when no plain one does.
      if (pathKind(path) !== kind) continue;
      // Estimates stay in metrics but are never reported as cost or credits spent.
      if (ESTIMATE_PATH.test(path)) continue;
      if (
        out.cost_usd === undefined &&
        /^(cost|total_cost|cost_usd|usd)$/i.test(leaf) &&
        // OpenRouter's GET /generation reports the charge as data.total_cost.
        (/usage|^cost|billing/i.test(path) || path === "data.total_cost")
      ) {
        out.cost_usd = value;
        out.sources = { ...out.sources, cost_usd: `body.${path}` };
      } else if (out.credits === undefined && /credit/i.test(leaf)) {
        out.credits = value;
        out.sources = { ...out.sources, credits: `body.${path}` };
      }
    }
  }
  if (providerMoney) {
    if (providerMoney.cost_usd !== undefined) out.cost_usd = providerMoney.cost_usd;
    if (providerMoney.credits !== undefined) out.credits = providerMoney.credits;
    if (providerMoney.sources) out.sources = providerMoney.sources;
  }
  if (headers) {
    for (const name of USAGE_HEADERS) {
      const raw = headers.get(name);
      if (raw === null) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && raw.trim() !== "") {
        out.metrics[`header.${name}`] = n;
        // ElevenLabs bills in characters (its credit unit) and reports them here.
        if (name === "character-cost" && out.credits === undefined) {
          out.credits = n;
          out.sources = { ...out.sources, credits: `header.${name}` };
        }
      } else if (/(request|generation)-?id/i.test(name) && raw.length <= 128 && out.ids.length < 5)
        out.ids.push(raw);
    }
  }
  return out;
}

/** True when the record carries anything worth keeping. */
export function hasUsage(usage: ResponseUsage): boolean {
  return (
    Object.keys(usage.tokens).length > 0 ||
    usage.cost_usd !== undefined ||
    usage.credits !== undefined ||
    Object.keys(usage.metrics).length > 0
  );
}
