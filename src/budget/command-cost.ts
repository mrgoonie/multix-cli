/**
 * Which commands can be priced before they run, and the spend guard
 * (runtime-neutral). The CLI (agent runtime) and the MCP Worker (multix_run)
 * share these so `--estimate` / `--max-cost` and `estimate` / `max_cost_usd`
 * answer the same way. Options are read by long name in kebab-case (MCP) or
 * camelCase (commander), so either caller can pass its own record.
 */

import { BudgetError } from "../core/errors.js";
import { TASK_DEFAULTS as ELEVENLABS_DEFAULTS } from "../providers/elevenlabs/models.js";
import { DEFAULT_FISH_TTS_MODEL } from "../providers/fish/models.js";
import { LYRIA_MODEL_DEFAULT } from "../providers/gemini/lyria.js";
import { TTS_MODEL_DEFAULT as GEMINI_TTS_DEFAULT } from "../providers/gemini/voices.js";
import {
  DEFAULT_OPENROUTER_STT_MODEL,
  DEFAULT_OPENROUTER_TTS_MODEL,
} from "../providers/openrouter/speech-defaults.js";
import { type SumeCatalogSnapshot, estimateSumeCost } from "../providers/sume/cost.js";
import { SPEECH_PROVIDERS, type SpeechProvider } from "../speech/speech-catalog.js";
import { parseRouteSpec, resolveTarget } from "../speech/speech-request.js";
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

export interface CommandDefaults {
  model?: string;
  /** Length of the input audio, measured by a caller that can read the file. */
  audioSeconds?: number;
  /** Text read from a file by a caller that can read it (`speech generate --text-file`). */
  text?: string;
  /** Per-provider default models with env overrides applied (`speech generate`). */
  speechModels?: Partial<Record<SpeechProvider, string>>;
  /**
   * `sume image|video`: the cached Sume catalog (its date, source and the
   * model's row), read by a caller that has the cache. Without it the price is unknown.
   */
  sumeCatalog?: SumeCatalogSnapshot;
  at?: Date;
}

/** Speaker labels ("Joe:") of multi-speaker text are part of the text; nothing extra to add. */
type RequestBuilder = (options: Options, defaults: CommandDefaults) => EstimateRequest | undefined;

/** OpenRouter matches model ids ignoring case; the price list spells them in lower case. */
const openrouterModel = (o: Options, d: CommandDefaults, fallback: string) =>
  (opt(o, "model") ?? d.model ?? fallback).trim().toLowerCase();

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
  "openrouter tts": (o, d) => {
    const text = opt(o, "text") ?? opt(o, "prompt");
    if (text === undefined) return undefined;
    const instructions = opt(o, "instructions");
    return {
      provider: "openrouter",
      model: openrouterModel(o, d, DEFAULT_OPENROUTER_TTS_MODEL),
      text,
      ...(instructions ? { extra_text: [instructions] } : {}),
    };
  },
  // One flat charge per song; the prompt, lyrics and format do not change it.
  "gemini generate-music": (o, d) => ({
    provider: "gemini",
    model: (opt(o, "model") ?? d.model ?? LYRIA_MODEL_DEFAULT).trim().replace(/^models\//, ""),
    text: "",
  }),
  // One flat charge per successful request; the prompt does not change it.
  "fish voice-design": () => ({ provider: "fish", model: "voice-design-1", text: "" }),
  "fish tts": (o, d) => {
    const text = opt(o, "text") ?? opt(o, "prompt") ?? d.text;
    if (text === undefined) return undefined;
    // Fish bills the UTF-8 bytes of the text exactly as sent (tags included); the model is the header.
    return {
      provider: "fish",
      model: (opt(o, "model") ?? d.model ?? DEFAULT_FISH_TTS_MODEL).trim(),
      text,
    };
  },
  "openrouter transcribe": (o, d) => {
    if (opt(o, "input") === undefined) return undefined;
    return {
      provider: "openrouter",
      model: openrouterModel(o, d, DEFAULT_OPENROUTER_STT_MODEL),
      text: "",
      ...(d.audioSeconds !== undefined ? { audio_seconds: d.audioSeconds } : {}),
    };
  },
};

/** What a command needs before it can be priced, for the "missing_input" detail. */
const NEEDS: Record<string, string> = {
  "openrouter tts": "--text or --prompt (text from --text-file or --turns-file is not priced)",
  "openrouter transcribe": "the audio to transcribe (--input)",
  "fish tts": "--text, --prompt or (from the CLI) a readable --text-file or --turns-file",
};

/** Priced from the model's row in Sume's catalog (per image or per second). */
const SUME_COMMANDS = ["sume image", "sume video"] as const;

/**
 * Requests that cost nothing even though they POST: a provider's own price
 * quote. They are priced at a proven $0, so --max-cost lets them through, and
 * their receipts are observations rather than charges.
 */
const FREE_COMMANDS: ReadonlySet<string> = new Set(["sume estimate"]);

export function isFreeCommand(command: string): boolean {
  return FREE_COMMANDS.has(command);
}

/** Commands with a pre-flight estimator. */
export function pricedCommands(): string[] {
  return [...Object.keys(BUILDERS), "speech generate", ...SUME_COMMANDS];
}

function unknownEstimate(
  command: string,
  reason: string,
  detail: string,
  model: string,
  at: Date | undefined,
): CostEstimate {
  return {
    status: "unknown",
    reason,
    detail,
    currency: "USD",
    provider: command.split(" ")[0] ?? "",
    model,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
    upper_bound: "none",
    text: { characters: 0, nfc_characters: 0, utf8_bytes: 0, utf16_units: 0 },
    units: {},
    assumptions: [],
    at: (at ?? new Date()).toISOString(),
  };
}

/** The provider command whose estimator prices a `speech generate` route on that provider. */
const SPEECH_ROUTE_COMMANDS: Partial<Record<SpeechProvider, string>> = {
  gemini: "gemini generate-speech",
  elevenlabs: "elevenlabs tts",
  fish: "fish tts",
  openrouter: "openrouter tts",
};

const SPEECH_DEFAULT_MODELS: Partial<Record<SpeechProvider, string>> = {
  gemini: GEMINI_TTS_DEFAULT,
  elevenlabs: ELEVENLABS_DEFAULTS.ttsModel,
  fish: DEFAULT_FISH_TTS_MODEL,
  openrouter: DEFAULT_OPENROUTER_TTS_MODEL,
};

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

/** `--extra provider.key=value`: a record from commander, or repeated strings from MCP. */
function speechExtras(options: Options): Record<string, string> {
  const value = options.extra;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  }
  return Object.fromEntries(
    list(value)
      .map((v) => [v.slice(0, v.indexOf("=")).trim(), v.slice(v.indexOf("=") + 1)])
      .filter(([k]) => k),
  );
}

/**
 * `speech generate` runs one route: the primary, or a `--fallback` taken only
 * when the routes before it have no key. Any of them may run, so the run is
 * priced at its most expensive route, and is unknown when any route is unpriced.
 */
function estimateSpeech(o: Options, d: CommandDefaults): CostEstimate {
  const command = "speech generate";
  const text = (opt(o, "text") ?? d.text)?.trim();
  if (!text) {
    return unknownEstimate(
      command,
      "missing_input",
      `Cannot estimate ${command} without --text (or, from the CLI, a readable --text-file)`,
      opt(o, "model") ?? "",
      d.at,
    );
  }
  const defaultModel = (p: SpeechProvider) => d.speechModels?.[p] ?? SPEECH_DEFAULT_MODELS[p] ?? "";
  let routes: Array<{ provider: SpeechProvider; model: string }>;
  try {
    const primary = resolveTarget(opt(o, "provider"), opt(o, "model"), defaultModel);
    routes = [primary];
    for (const spec of list(o.fallback)) {
      const { provider, model } = parseRouteSpec(spec);
      if (!(SPEECH_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(`unknown speech provider "${provider}" in --fallback ${spec}`);
      }
      const p = provider as SpeechProvider;
      routes.push({ provider: p, model: model ?? defaultModel(p) });
    }
  } catch (error) {
    return unknownEstimate(
      command,
      "missing_input",
      `Cannot price ${command}: ${(error as Error).message}`,
      opt(o, "model") ?? "",
      d.at,
    );
  }
  const extras = speechExtras(o);
  const style = opt(o, "style");
  const estimates: CostEstimate[] = [];
  for (const route of routes) {
    const label = `${route.provider}/${route.model}`;
    const routeCommand = SPEECH_ROUTE_COMMANDS[route.provider];
    if (!routeCommand) {
      return unknownEstimate(
        command,
        "unsupported",
        `No price for the ${label} route${routes.length > 1 ? " (a run may take any route it lists)" : ""}; priced speech providers: ${Object.keys(SPEECH_ROUTE_COMMANDS).join(", ")}`,
        route.model,
        d.at,
      );
    }
    const routeOptions: Options =
      route.provider === "gemini"
        ? { text, model: route.model, style }
        : route.provider === "fish"
          ? { text, model: route.model }
          : route.provider === "openrouter"
            ? { text, model: route.model, instructions: style }
            : {
                text,
                model: route.model,
                "previous-text": extras["elevenlabs.previous_text"],
                "next-text": extras["elevenlabs.next_text"],
              };
    const estimate = estimateCommand(routeCommand, routeOptions, { at: d.at });
    if (estimate.status !== "estimated") {
      return { ...estimate, detail: `${label} route: ${estimate.detail}` };
    }
    estimates.push(estimate);
  }
  const top = estimates.reduce((a, b) => ((b.high_usd ?? 0) > (a.high_usd ?? 0) ? b : a));
  if (estimates.length === 1) return top;
  const proven = estimates.every((e) => e.upper_bound === "proven");
  const lows = estimates.map((e) => e.low_usd ?? 0);
  return {
    ...top,
    // The range spans every route; the expected cost is the primary route's, which runs when its key is set.
    low_usd: Math.min(...lows),
    expected_usd: estimates[0]?.expected_usd ?? top.expected_usd,
    upper_bound: proven ? "proven" : "estimated",
    assumptions: [
      ...top.assumptions,
      `Priced at the most expensive of ${estimates.length} routes (${routes.map((r) => `${r.provider}/${r.model}`).join(", ")}); only one runs.`,
    ],
  };
}

/**
 * Estimate a command from its options. Commands without an estimator (or
 * missing the text to price) get an "unknown" estimate, never $0.
 */
export function estimateCommand(
  command: string,
  options: Options,
  defaults: CommandDefaults = {},
): CostEstimate {
  // MCP callers may spell keys as CLI flags ("--text"), like multix_run accepts.
  const named = Object.fromEntries(
    Object.entries(options).map(([k, v]) => [k.replace(/^-+/, ""), v]),
  );
  if (command === "speech generate") return estimateSpeech(named, defaults);
  if (isFreeCommand(command)) {
    return {
      ...unknownEstimate(command, "", "", opt(named, "model") ?? "", defaults.at),
      status: "estimated",
      reason: undefined,
      detail: undefined,
      low_usd: 0,
      expected_usd: 0,
      high_usd: 0,
      upper_bound: "proven",
      assumptions: [`${command} is a free price quote; it starts no paid work.`],
    };
  }
  if (command === "sume image" || command === "sume video") {
    return estimateSumeCost({
      command: command === "sume image" ? "image" : "video",
      model: (opt(named, "model") ?? defaults.model ?? "").trim(),
      options: named,
      catalog: defaults.sumeCatalog,
      at: defaults.at,
    });
  }
  const builder = BUILDERS[command];
  const req = builder?.(named, defaults);
  if (req) return estimateCost({ ...req, at: defaults.at });
  return unknownEstimate(
    command,
    builder ? "missing_input" : "unsupported",
    builder
      ? `Cannot estimate ${command} without ${NEEDS[command] ?? "the text to speak"}`
      : `No pre-flight estimator for ${command || "this command"}; priced commands: ${pricedCommands().join(", ")}`,
    opt(named, "model") ?? defaults.model ?? "",
    defaults.at,
  );
}

export function parseMaxCost(value: unknown): number {
  if (typeof value === "string" && !/^\s*\d+(\.\d+)?\s*$/.test(value)) throw invalidMaxCost(value);
  const n = typeof value === "number" ? value : Number(String(value).trim());
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
      `Refusing to run: cost of ${[estimate.provider, estimate.model].filter(Boolean).join(" ")} is unknown (${estimate.reason}: ${estimate.detail}), so --max-cost ${usd(maxCost)} cannot be guaranteed.`,
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
