/**
 * Which commands can be priced before they run, and the spend guard
 * (runtime-neutral). The CLI (agent runtime) and the MCP Worker (multix_run)
 * share these so `--estimate` / `--max-cost` and `estimate` / `max_cost_usd`
 * answer the same way. Options are read by long name in kebab-case (MCP) or
 * camelCase (commander), so either caller can pass its own record.
 */

import { BudgetError } from "../core/errors.js";
import { ATLAS_DEFAULT_MODELS } from "../providers/atlascloud/models.js";
import { type Atlas3dPriceSnapshot, estimateAtlas3dCost } from "../providers/atlascloud/pricing.js";
import { TASK_DEFAULTS as ELEVENLABS_DEFAULTS } from "../providers/elevenlabs/models.js";
import { DEFAULT_FISH_TTS_MODEL } from "../providers/fish/models.js";
import { MUSIC_MODEL_DEFAULT as GEMINI_MUSIC_DEFAULT } from "../providers/gemini/lyria.js";
import { TTS_MODEL_DEFAULT as GEMINI_TTS_DEFAULT } from "../providers/gemini/voices.js";
import {
  DEFAULT_OPENROUTER_STT_MODEL,
  DEFAULT_OPENROUTER_TTS_MODEL,
} from "../providers/openrouter/speech-defaults.js";
import { type SumeCatalogSnapshot, estimateSumeCost } from "../providers/sume/cost.js";
import { SPEECH_PROVIDERS, type SpeechProvider } from "../speech/speech-catalog.js";
import { parseRouteSpec, resolveTarget } from "../speech/speech-request.js";
import {
  type CostEstimate,
  type EstimateRequest,
  type UnitRange,
  estimateCost,
} from "./cost-estimate.js";

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
  /**
   * `elevenlabs music --plan`: the plan's total length (sum of its sections'
   * or chunks' `duration_ms`), read by a caller that can read the file.
   */
  planLengthMs?: number;
  /**
   * `atlas 3d` / `atlas run`: the cached Atlas Cloud 3D price list, read by a
   * caller that has the cache. Without it the price is unknown.
   */
  atlas3dPrices?: Atlas3dPriceSnapshot;
  /** `atlas run`: the parsed --input body, read by a caller that can read an @file. */
  atlasInput?: Record<string, unknown>;
  at?: Date;
}

/** Speaker labels ("Joe:") of multi-speaker text are part of the text; nothing extra to add. */
type RequestBuilder = (
  options: Options,
  defaults: CommandDefaults,
) => EstimateRequest | Unpriced | undefined;

/** OpenRouter matches model ids ignoring case; the price list spells them in lower case. */
const openrouterModel = (o: Options, d: CommandDefaults, fallback: string) =>
  (opt(o, "model") ?? d.model ?? fallback).trim().toLowerCase();

/**
 * A numeric option, read the way the command reads it: commander's string
 * through parseFloat (`sfx`) or parseInt (`music`), a number from MCP as is.
 * NaN when present but not a number.
 */
function num(options: Options, name: string, parse: (s: string) => number): number | undefined {
  const value = options[name] ?? options[camel(name)];
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return parse(value);
}

const roundMs = (n: number) => Math.round(n * 1000) / 1000;

type LengthResult = { ok: true; seconds: UnitRange; note: string } | { ok: false; detail: string };

/**
 * Output length the request asks for, in seconds: the set length, or the
 * provider's whole allowed range when the model picks one. Out-of-range or
 * malformed lengths are not priced (the API rejects them).
 */
function requestedSeconds(
  value: number | undefined,
  bounds: { min: number; max: number },
  unit: { name: string; perSecond: number },
): LengthResult {
  if (value === undefined) {
    return {
      ok: true,
      seconds: { low: bounds.min, expected: bounds.max, high: bounds.max },
      note: `No ${unit.name} set: the model picks the length, so the estimate assumes the longest it may pick (${bounds.max} s).`,
    };
  }
  const s = value / unit.perSecond;
  if (!(Number.isFinite(s) && s >= bounds.min && s <= bounds.max)) {
    return {
      ok: false,
      detail: `${unit.name} must be ${bounds.min * unit.perSecond} to ${bounds.max * unit.perSecond}, got ${Number.isNaN(value) ? "a non-number" : value}`,
    };
  }
  return {
    ok: true,
    seconds: { low: roundMs(s), expected: roundMs(s), high: roundMs(s) },
    note: `Priced on the requested ${roundMs(s)} s of audio.`,
  };
}

/** ElevenLabs' sound-generation default model; the CLI sends no model_id. */
export const ELEVENLABS_SFX_MODEL = "eleven_text_to_sound_v2";
const SFX_SECONDS = { min: 0.5, max: 30 };
/** music_length_ms and a plan's total are bounded by the API to 3 s..10 min. */
const MUSIC_SECONDS = { min: 3, max: 600 };

/** Scribe models ElevenLabs still serves but no longer prices on its API price list. */
const DEPRECATED_SCRIBE_MODELS = ["scribe_v1", "scribe_v1_experimental"] as const;

/** Why a builder could not price a request it knows, for the "missing_input" detail. */
class Unpriced {
  constructor(readonly detail: string) {}
}

function lengthRequest(
  model: string,
  task: "sfx" | "music",
  length: LengthResult,
): EstimateRequest | Unpriced {
  if (!length.ok) return new Unpriced(length.detail);
  return {
    provider: "elevenlabs",
    model,
    text: "",
    task,
    output_seconds: length.seconds,
    output_note: length.note,
  };
}

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
  // Lyria bills one flat price per song, whatever the prompt, lyrics or length.
  "gemini generate-music": (o, d) => ({
    provider: "gemini",
    model: (opt(o, "model") ?? d.model ?? GEMINI_MUSIC_DEFAULT).trim(),
    text: "",
    task: "music",
  }),
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
  // Billed per minute of sound: the set --duration-seconds, or up to 30 s when the model picks.
  "elevenlabs sfx": (o) => {
    if ((opt(o, "text") ?? opt(o, "prompt")) === undefined) return undefined;
    const seconds = num(o, "duration-seconds", Number.parseFloat);
    return lengthRequest(
      ELEVENLABS_SFX_MODEL,
      "sfx",
      requestedSeconds(seconds, SFX_SECONDS, { name: "--duration-seconds", perSecond: 1 }),
    );
  },
  // Billed per minute of music: --music-length-ms, a --plan's total, or up to 10 min when the model picks.
  "elevenlabs music": (o, d) => {
    const model = (opt(o, "model") ?? d.model ?? "music_v1").trim();
    const ms = num(o, "music-length-ms", (v) => Number.parseInt(v, 10));
    if (opt(o, "plan") !== undefined) {
      if (opt(o, "prompt") !== undefined || ms !== undefined) {
        return new Unpriced("--plan cannot be combined with --prompt or --music-length-ms");
      }
      if (d.planLengthMs === undefined) return undefined;
      const length = requestedSeconds(d.planLengthMs, MUSIC_SECONDS, {
        name: "the plan's total duration_ms",
        perSecond: 1000,
      });
      if (length.ok) length.note = `Priced on the plan's total ${length.seconds.high} s of music.`;
      return lengthRequest(model, "music", length);
    }
    if (opt(o, "prompt") === undefined) return undefined;
    // The command sends parseInt's whole milliseconds.
    const whole = ms === undefined || !Number.isFinite(ms) ? ms : Math.trunc(ms);
    return lengthRequest(
      model,
      "music",
      requestedSeconds(whole, MUSIC_SECONDS, { name: "--music-length-ms", perSecond: 1000 }),
    );
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
      task: "transcription",
      ...(d.audioSeconds !== undefined ? { audio_seconds: d.audioSeconds } : {}),
    };
  },
  // Billed per minute of input audio; the length is read from the local --input file.
  "elevenlabs transcribe": (o, d) => {
    if (opt(o, "input") === undefined) return undefined;
    const model = (opt(o, "model") ?? d.model ?? ELEVENLABS_DEFAULTS.sttModel).trim();
    if ((DEPRECATED_SCRIBE_MODELS as readonly string[]).includes(model)) {
      return new Unpriced(
        `${model} is deprecated and ElevenLabs publishes no price for it; pass --model scribe_v2 or scribe_v3`,
      );
    }
    return {
      provider: "elevenlabs",
      model,
      text: "",
      task: "transcription",
      ...(d.audioSeconds !== undefined ? { audio_seconds: d.audioSeconds } : {}),
    };
  },
};

/** What a command needs before it can be priced, for the "missing_input" detail. */
const NEEDS: Record<string, string> = {
  "openrouter tts": "--text or --prompt (text from --text-file or --turns-file is not priced)",
  "openrouter transcribe": "the audio to transcribe (--input)",
  "elevenlabs transcribe": "the audio to transcribe (--input)",
  "fish tts": "--text, --prompt or (from the CLI) a readable --text-file or --turns-file",
  "elevenlabs sfx": "--text or --prompt",
  "elevenlabs music":
    "--prompt, or (from the CLI) a readable --plan whose sections or chunks all set duration_ms",
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

/**
 * Priced from Atlas Cloud's live 3D price list. `atlas run` is priced only for
 * 3D models; the caller decides when an `atlas run` model is one.
 */
const ATLAS_3D_COMMANDS = ["atlas 3d", "atlas run"] as const;

/** `atlas 3d`'s built-in model: image-to-3D with --ref, text-to-3D without. */
function atlas3dDefault(options: Options): string {
  return list(options.ref).length > 0
    ? ATLAS_DEFAULT_MODELS.imageTo3d
    : ATLAS_DEFAULT_MODELS.textTo3d;
}

/** Commands with a pre-flight estimator. */
export function pricedCommands(): string[] {
  return [...Object.keys(BUILDERS), "speech generate", ...SUME_COMMANDS, "atlas 3d"];
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
  if ((ATLAS_3D_COMMANDS as readonly string[]).includes(command)) {
    // `atlas run <modelId>` takes the model as an argument; the caller passes it as the default.
    const inline = command === "atlas run" ? opt(named, "input") : undefined;
    let input = defaults.atlasInput;
    if (!input && inline?.trim().startsWith("{")) {
      try {
        input = JSON.parse(inline) as Record<string, unknown>;
      } catch {
        input = undefined;
      }
    }
    return estimateAtlas3dCost({
      command,
      model: (command === "atlas 3d"
        ? (opt(named, "model") ?? defaults.model ?? atlas3dDefault(named))
        : (defaults.model ?? "")
      ).trim(),
      ...(input ? { input } : {}),
      ...(defaults.atlas3dPrices ? { prices: defaults.atlas3dPrices } : {}),
      at: defaults.at,
    });
  }
  const builder = BUILDERS[command];
  const req = builder?.(named, defaults);
  if (req instanceof Unpriced) {
    return unknownEstimate(
      command,
      "missing_input",
      `Cannot estimate ${command}: ${req.detail}`,
      opt(named, "model") ?? defaults.model ?? "",
      defaults.at,
    );
  }
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
      `Refusing to run: ${estimate.provider === "atlas" ? "Atlas Cloud quotes the final price at submit time" : "the provider bills output it has not produced yet"}, so the high estimate ${usd(estimate.high_usd)} is not a proven cap. Re-run with --cost-policy estimate to accept the estimated high end against --max-cost ${usd(maxCost)}.`,
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
