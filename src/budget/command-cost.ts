/**
 * Which commands can be priced before they run, and the spend guard
 * (runtime-neutral). The CLI (agent runtime) and the MCP Worker (multix_run)
 * share these so `--estimate` / `--max-cost` and `estimate` / `max_cost_usd`
 * answer the same way. Options are read by long name in kebab-case (MCP) or
 * camelCase (commander), so either caller can pass its own record.
 */

import { BudgetError } from "../core/errors.js";
import { TASK_DEFAULTS as ELEVENLABS_DEFAULTS } from "../providers/elevenlabs/models.js";
import { TTS_MODEL_DEFAULT as GEMINI_TTS_DEFAULT } from "../providers/gemini/voices.js";
import { type CostEstimate, type EstimateRequest, estimateCost } from "./cost-estimate.js";

export type CostPolicy = "strict" | "estimate";
export const COST_POLICIES: readonly CostPolicy[] = ["strict", "estimate"];

type Options = Record<string, unknown>;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function opt(options: Options, name: string): string | undefined {
  const value = options[name] ?? options[camel(name)];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Speaker labels ("Joe:") of multi-speaker text are part of the text; nothing extra to add. */
type RequestBuilder = (
  options: Options,
  defaults: { model?: string },
) => EstimateRequest | undefined;

const BUILDERS: Record<string, RequestBuilder> = {
  "gemini generate-speech": (o, d) => {
    const text = opt(o, "text") ?? opt(o, "prompt");
    if (text === undefined) return undefined;
    const style = opt(o, "style");
    return {
      provider: "gemini",
      model: opt(o, "model") ?? d.model ?? GEMINI_TTS_DEFAULT,
      text,
      ...(style ? { extra_text: [style] } : {}),
    };
  },
  "elevenlabs tts": (o, d) => {
    const text = opt(o, "text") ?? opt(o, "prompt");
    if (text === undefined) return undefined;
    return {
      provider: "elevenlabs",
      model: opt(o, "model") ?? d.model ?? ELEVENLABS_DEFAULTS.ttsModel,
      text,
      extra_text: [opt(o, "previous-text"), opt(o, "next-text")].filter(
        (t): t is string => t !== undefined,
      ),
    };
  },
};

/** Commands with a pre-flight estimator. */
export function pricedCommands(): string[] {
  return Object.keys(BUILDERS);
}

/**
 * Estimate a command from its options. Commands without an estimator (or
 * missing the text to price) get an "unknown" estimate, never $0.
 */
export function estimateCommand(
  command: string,
  options: Options,
  defaults: { model?: string; at?: Date } = {},
): CostEstimate {
  const builder = BUILDERS[command];
  const req = builder?.(options, defaults);
  if (req) return estimateCost({ ...req, at: defaults.at });
  const at = (defaults.at ?? new Date()).toISOString();
  const model = opt(options, "model") ?? defaults.model ?? "";
  return {
    status: "unknown",
    reason: builder ? "missing_input" : "unsupported",
    detail: builder
      ? `Cannot estimate ${command} without the text to speak`
      : `No pre-flight estimator for ${command || "this command"}; priced commands: ${pricedCommands().join(", ")}`,
    currency: "USD",
    provider: command.split(" ")[0] ?? "",
    model,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0 },
    units: {},
    assumptions: [],
    at,
  };
}

export function parseMaxCost(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (typeof value === "string" && value.trim() === "") throw invalidMaxCost(value);
  if (!Number.isFinite(n) || n < 0) throw invalidMaxCost(value);
  return n;
}

function invalidMaxCost(value: unknown): BudgetError {
  return new BudgetError(
    `Invalid --max-cost: ${String(value)}. Pass a USD amount such as 0.25.`,
    "INVALID_INPUT",
  );
}

export function parseCostPolicy(value: unknown): CostPolicy {
  if (value === undefined) return "strict";
  if (COST_POLICIES.includes(value as CostPolicy)) return value as CostPolicy;
  throw new BudgetError(
    `Invalid --cost-policy: ${String(value)}. Use ${COST_POLICIES.join(" or ")}.`,
    "INVALID_INPUT",
  );
}

/**
 * Fail closed before anything is sent. A run passes only when the estimate's
 * ceiling is at most `maxCost`; the ceiling must be proven unless the caller
 * chose policy "estimate" (accept the estimated high end). An unknown price
 * never passes: multix does not promise a cap it cannot back.
 */
export function checkBudget(estimate: CostEstimate, maxCost: number, policy: CostPolicy): void {
  const usd = (n: number) =>
    n === 0 ? "$0" : `$${n < 0.01 ? Number(n.toPrecision(3)).toString() : n.toFixed(4)}`;
  if (estimate.status !== "estimated" || estimate.high_usd === null) {
    throw new BudgetError(
      `Refusing to run: cost of ${estimate.provider} ${estimate.model} is unknown (${estimate.reason}: ${estimate.detail}), so --max-cost ${usd(maxCost)} cannot be guaranteed.`,
      "BUDGET_UNPROVEN",
    );
  }
  if (estimate.upper_bound !== "proven" && policy !== "estimate") {
    throw new BudgetError(
      `Refusing to run: the provider bills output it has not produced yet, so the high estimate ${usd(estimate.high_usd)} is not a proven cap. Re-run with --cost-policy estimate to accept the estimated high end against --max-cost ${usd(maxCost)}.`,
      "BUDGET_UNPROVEN",
    );
  }
  if (estimate.high_usd > maxCost) {
    throw new BudgetError(
      `Refusing to run: estimated cost up to ${usd(estimate.high_usd)} exceeds --max-cost ${usd(maxCost)}.`,
      "BUDGET_EXCEEDED",
    );
  }
}
