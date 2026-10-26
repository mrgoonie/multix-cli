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
}

const METRIC_KEY =
  /(token|cost|credit|price|usage|billing|duration|seconds|_time$|^time$|time_ms|latency|characters?_?(count|cost)|units?$|predict|inference)/i;
const SKIP_KEY =
  /(_at$|stamp|date|created|updated|expire|limit|max_|min_|width|height|seed|fps|index|count_?max)/i;
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
]);
const USAGE_HEADERS = [
  "x-request-id",
  "request-id",
  "x-amzn-requestid",
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

/** Known token shapes: Gemini usageMetadata, OpenAI/OpenRouter/BytePlus usage. */
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
      pick(usage, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens") ?? into.input;
    into.output =
      pick(usage, "completion_tokens", "output_tokens", "completionTokens", "outputTokens") ??
      into.output;
    into.total = pick(usage, "total_tokens", "totalTokens") ?? into.total;
    const details =
      asRecord(usage.completion_tokens_details) ?? asRecord(usage.output_tokens_details);
    if (details) into.thinking = pick(details, "reasoning_tokens") ?? into.thinking;
  }
}

function walk(value: unknown, path: string, depth: number, out: ResponseUsage): void {
  if (depth > MAX_DEPTH || Object.keys(out.metrics).length >= MAX_METRICS) return;
  if (Array.isArray(value)) {
    // Arrays of outputs/images rarely carry usage; look at the first few only.
    value.slice(0, 3).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1, out));
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
      depth <= 2 &&
      ID_KEYS.has(key) &&
      typeof child === "string" &&
      child.length > 0 &&
      child.length <= 128 &&
      !out.ids.includes(child)
    ) {
      if (out.ids.length < 5) out.ids.push(child);
    } else if (child && typeof child === "object") {
      walk(child, childPath, depth + 1, out);
    }
  }
}

/** Extract usage from one parsed JSON response body and its headers. */
export function extractUsage(body: unknown, headers?: Headers | null): ResponseUsage {
  const out: ResponseUsage = { tokens: {}, metrics: {}, ids: [] };
  const obj = asRecord(body);
  if (obj) {
    tokensFrom(obj, out.tokens);
    walk(obj, "", 0, out);
  }
  for (const [path, value] of Object.entries(out.metrics)) {
    const leaf = path.split(".").pop() ?? path;
    // Estimates stay in metrics but are never reported as cost or credits spent.
    if (ESTIMATE_PATH.test(path)) continue;
    if (
      out.cost_usd === undefined &&
      /^(cost|total_cost|cost_usd|usd)$/i.test(leaf) &&
      /usage|^cost|billing/i.test(path)
    ) {
      out.cost_usd = value;
    } else if (out.credits === undefined && /credit/i.test(leaf)) {
      out.credits = value;
    }
  }
  if (headers) {
    for (const name of USAGE_HEADERS) {
      const raw = headers.get(name);
      if (raw === null) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && raw.trim() !== "") {
        out.metrics[`header.${name}`] = n;
        // ElevenLabs bills in characters (its credit unit) and reports them here.
        if (name === "character-cost" && out.credits === undefined) out.credits = n;
      } else if (/request-?id/i.test(name) && raw.length <= 128 && out.ids.length < 5)
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
