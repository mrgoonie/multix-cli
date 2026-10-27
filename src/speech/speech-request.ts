/**
 * The provider-neutral speech request (`multix.speech.request/v1`) and the
 * checks that run before any provider is called: explicit provider/model
 * routing, voice ids that belong to the chosen provider, and options the
 * model actually supports. Nothing here falls back or retries; a fallback
 * target is only ever one the caller listed (see planSpeechRoutes).
 * Data only: no `node:*` imports.
 */

import { ValidationError } from "../core/errors.js";
import { ELEVENLABS_RECOMMENDED_VOICES } from "../providers/elevenlabs/models.js";
import { findSpeechModel as findFalSpeechModel } from "../providers/fal/speech-models.js";
import { FISH_PUBLIC_VOICES } from "../providers/fish/models.js";
import { GEMINI_TTS_VOICES, isVoiceAllowedForModel } from "../providers/gemini/voices.js";
import { OPENAI_TTS_VOICES } from "../providers/openai/models.js";
import { OPENROUTER_MAX_SPEED } from "../providers/openrouter/speech-defaults.js";
import {
  SPEECH_FORMATS,
  SPEECH_PROVIDERS,
  SPEECH_PROVIDER_INFO,
  type SpeechFormat,
  type SpeechModel,
  type SpeechProvider,
  findSpeechModel,
  isSpeechFormat,
  isSpeechProvider,
  speechModels,
} from "./speech-catalog.js";

/** The nine voices tts-1 and tts-1-hd take; newer voices need gpt-4o-mini-tts. */
const OPENAI_TTS1_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];

export const SPEECH_REQUEST_SCHEMA = "multix.speech.request/v1";
export const SPEECH_RESULT_SCHEMA = "multix.speech.result/v1";

export interface SpeakerVoice {
  speaker: string;
  voice: string;
}

/** What the caller asked for, independent of any provider. */
export interface SpeechInput {
  text: string;
  voice?: string;
  speakers: SpeakerVoice[];
  language?: string;
  style?: string;
  emotion?: string;
  format?: SpeechFormat;
  async: boolean;
  /** `<provider>.<key>` → raw value, from `--extra`. */
  extras: Record<string, string>;
}

/** One provider/model the request may run on, with its voice resolved. */
export interface SpeechRoute {
  provider: SpeechProvider;
  model: string;
  /** Single-speaker voice (absent in multi-speaker mode). */
  voice?: string;
  voice_defaulted: boolean;
  format?: SpeechFormat;
  capability: SpeechModel;
  /** Typed provider options for this route (namespaced extras with the prefix removed). */
  extras: Record<string, string | number | boolean>;
}

/** Parse `provider[:model[:voice]]` from `--fallback`. */
export function parseRouteSpec(spec: string): { provider: string; model?: string; voice?: string } {
  const [provider = "", model, ...voice] = spec.split(":");
  if (!provider)
    throw new ValidationError(`--fallback must be provider[:model[:voice]] (got "${spec}")`);
  return {
    provider,
    ...(model ? { model } : {}),
    ...(voice.length && voice.join(":") ? { voice: voice.join(":") } : {}),
  };
}

/** `--extra <provider>.<key>=<value>` accumulator. */
export function collectExtra(value: string, prev: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  const name = eq > 0 ? value.slice(0, eq).trim() : "";
  if (!/^[a-z]+\.[a-z_]+$/.test(name)) {
    throw new ValidationError(
      `--extra must be <provider>.<key>=<value>, e.g. elevenlabs.stability=0.4 (got "${value}")`,
    );
  }
  return { ...prev, [name]: value.slice(eq + 1) };
}

/** `--speaker name:voice` accumulator. */
export function collectSpeaker(value: string, prev: SpeakerVoice[]): SpeakerVoice[] {
  const idx = value.indexOf(":");
  const speaker = value.slice(0, idx).trim();
  const voice = value.slice(idx + 1).trim();
  if (idx <= 0 || !speaker || !voice) {
    throw new ValidationError(`--speaker must be "name:voice" (got "${value}")`);
  }
  return [...prev, { speaker, voice }];
}

function providerList(): string {
  return SPEECH_PROVIDERS.join(", ");
}

function requireProvider(value: string): SpeechProvider {
  if (!isSpeechProvider(value)) {
    throw new ValidationError(`Unknown speech provider "${value}". Valid: ${providerList()}`);
  }
  return value;
}

/** Providers that list `model`; used to explain a model given to the wrong provider. */
function providersOf(model: string): SpeechProvider[] {
  return [
    ...new Set(
      speechModels()
        .filter((m) => m.model === model)
        .map((m) => m.provider),
    ),
  ];
}

/**
 * Provider and model for a request. Only explicit choices are used: a model
 * without a provider must belong to exactly one provider, and nothing is
 * picked when neither is given.
 */
export function resolveTarget(
  provider: string | undefined,
  model: string | undefined,
  defaultModel: (provider: SpeechProvider) => string,
): { provider: SpeechProvider; model: string; inferred: boolean } {
  if (!provider) {
    if (!model) {
      throw new ValidationError(
        `Choose a provider: --provider <${SPEECH_PROVIDERS.join("|")}> (and optionally --model). List options with: multix speech models`,
      );
    }
    const owners = providersOf(model);
    if (owners.length !== 1) {
      throw new ValidationError(
        owners.length === 0
          ? `Unknown speech model "${model}": pass --provider too, or list models with: multix speech models`
          : `Model "${model}" is served by ${owners.join(" and ")}; pass --provider to choose`,
      );
    }
    return { provider: owners[0] as SpeechProvider, model, inferred: true };
  }
  const p = requireProvider(provider);
  return { provider: p, model: model ?? defaultModel(p), inferred: false };
}

/** Error text when `voice` is not a voice of `provider`/`model`, else undefined. */
export function voiceProblem(
  provider: SpeechProvider,
  model: string,
  voice: string,
): string | undefined {
  const elsewhere = (): string => {
    if ((OPENAI_TTS_VOICES as readonly string[]).includes(voice)) return " (it is an OpenAI voice)";
    if ((GEMINI_TTS_VOICES as readonly string[]).includes(voice)) return " (it is a Gemini voice)";
    if (/^[A-Za-z0-9]{20}$/.test(voice)) return " (it looks like an ElevenLabs voice id)";
    return "";
  };
  switch (provider) {
    case "gemini":
      return isVoiceAllowedForModel(voice, model)
        ? undefined
        : `"${voice}" is not a Gemini voice for ${model}${elsewhere()}. Valid: ${GEMINI_TTS_VOICES.join(", ")}`;
    case "openai": {
      const valid = model.startsWith("tts-1") ? OPENAI_TTS1_VOICES : OPENAI_TTS_VOICES;
      return (valid as readonly string[]).includes(voice)
        ? undefined
        : `"${voice}" is not an OpenAI voice for ${model}${elsewhere()}. Valid: ${valid.join(", ")}`;
    }
    case "elevenlabs":
      // Voice ids are opaque, so only a name that belongs to another provider is rejected.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
        return `"${voice}" is not an ElevenLabs voice id (letters, digits, _ and - only). List voices with: multix elevenlabs voices list`;
      }
      return Object.hasOwn(ELEVENLABS_RECOMMENDED_VOICES, voice) ||
        elsewhere() === "" ||
        /^[A-Za-z0-9]{20}$/.test(voice)
        ? undefined
        : `"${voice}" is not an ElevenLabs voice id${elsewhere()}. List ElevenLabs voices with: multix elevenlabs voices list, or use one of: ${Object.keys(ELEVENLABS_RECOMMENDED_VOICES).join(", ")}`;
    case "fish":
      if (Object.hasOwn(FISH_PUBLIC_VOICES, voice.toLowerCase())) return undefined;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(voice) || elsewhere() !== "") {
        return `"${voice}" is not a Fish Audio voice id${elsewhere()}. Fish voice ids look like ${FISH_PUBLIC_VOICES.adrian}; list yours with: multix fish voices list`;
      }
      return undefined;
    case "fal": {
      // Gemini endpoints take a closed list of names; ElevenLabs ones take any voice name or id.
      const voices = findFalSpeechModel(model)?.voices;
      return !voices || voices.some((v) => v.toLowerCase() === voice.toLowerCase())
        ? undefined
        : `"${voice}" is not a voice of fal ${model}${elsewhere()}. Valid: ${voices.join(", ")}`;
    }
    case "minimax":
      return elsewhere() !== ""
        ? `"${voice}" is not a MiniMax voice id${elsewhere()}. MiniMax voice ids look like English_expressive_narrator`
        : undefined;
    default:
      return undefined;
  }
}

/** ElevenLabs accepts the recommended voice names as a shorthand for their ids. */
function canonicalVoice(provider: SpeechProvider, model: string, voice: string): string {
  if (provider === "elevenlabs" && Object.hasOwn(ELEVENLABS_RECOMMENDED_VOICES, voice)) {
    return ELEVENLABS_RECOMMENDED_VOICES[voice as keyof typeof ELEVENLABS_RECOMMENDED_VOICES];
  }
  if (provider === "fish") return FISH_PUBLIC_VOICES[voice.toLowerCase()] ?? voice;
  if (provider === "fal") {
    const voices = findFalSpeechModel(model)?.voices;
    return voices?.find((v) => v.toLowerCase() === voice.toLowerCase()) ?? voice;
  }
  return voice;
}

function parseExtraValue(
  name: string,
  raw: string,
  type: "number" | "string" | "boolean",
): string | number | boolean {
  if (type === "string") return raw;
  if (type === "boolean") {
    if (raw === "true" || raw === "false") return raw === "true";
    throw new ValidationError(`--extra ${name} must be true or false (got "${raw}")`);
  }
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new ValidationError(`--extra ${name} must be a number (got "${raw}")`);
  }
  return n;
}

/** Extras for `provider`, typed; unknown keys for it are an error, other providers' keys are left for their route. */
function extrasFor(
  provider: SpeechProvider,
  extras: Record<string, string>,
): Record<string, string | number | boolean> {
  const allowed = SPEECH_PROVIDER_INFO[provider].extras;
  const out: Record<string, string | number | boolean> = {};
  for (const [name, raw] of Object.entries(extras)) {
    const [ns = "", key = ""] = name.split(".");
    if (ns !== provider) continue;
    const type = allowed[key];
    if (!type) {
      const keys = Object.keys(allowed);
      throw new ValidationError(
        `--extra ${name} is not a ${provider} option. ${keys.length ? `Valid: ${keys.map((k) => `${provider}.${k}`).join(", ")}` : `${provider} takes no extras`}`,
      );
    }
    out[key] = parseExtraValue(name, raw, type);
  }
  return out;
}

/**
 * Check one route against the model's documented capabilities. Every problem
 * is reported together so a caller fixes them in one pass.
 */
export function buildRoute(
  target: { provider: SpeechProvider; model: string; voice?: string },
  input: SpeechInput,
): SpeechRoute {
  const { provider, model } = target;
  const info = SPEECH_PROVIDER_INFO[provider];
  const capability = findSpeechModel(provider, model);
  if (!capability) {
    const known = speechModels()
      .filter((m) => m.provider === provider)
      .map((m) => m.model);
    const owners = providersOf(model).filter((p) => p !== provider);
    throw new ValidationError(
      `${provider} has no speech model "${model}"${owners.length ? ` (it is a ${owners.join("/")} model)` : ""}. Valid: ${known.join(", ")}`,
    );
  }
  const problems: string[] = [];
  const label = `${provider}/${model}`;
  const multi = input.speakers.length > 0;

  if (multi && (target.voice ?? input.voice)) {
    problems.push("--voice and --speaker cannot be combined; give each speaker its voice");
  }
  if (input.text.length > (capability.max_chars ?? Number.POSITIVE_INFINITY)) {
    problems.push(
      `${label} takes at most ${capability.max_chars} characters per request (got ${input.text.length}); split the text`,
    );
  }
  if (multi && capability.max_speakers < 2) {
    problems.push(`${label} speaks with one voice; --speaker needs gemini`);
  } else if (input.speakers.length > capability.max_speakers) {
    problems.push(`${label} takes at most ${capability.max_speakers} speakers`);
  }
  const requested = target.voice ?? input.voice;
  // Atlas has no default voice: its models pick one when none is sent.
  const voice = multi
    ? undefined
    : canonicalVoice(provider, model, requested ?? capability.default_voice ?? info.default_voice);
  for (const v of multi ? input.speakers.map((s) => s.voice) : voice ? [voice] : []) {
    const problem = voiceProblem(provider, model, v);
    if (problem) problems.push(problem);
  }
  if (input.language && capability.languages && !capability.languages.includes(input.language)) {
    problems.push(
      `${label} does not list language "${input.language}" (documented: ${capability.languages.join(", ") || "none"})`,
    );
  }
  // The gateways name no language list and send none to a model without a language field,
  // so the flag would be dropped without a word.
  if (
    input.language &&
    (provider === "openrouter" || provider === "fal") &&
    !capability.language_param
  ) {
    problems.push(`${label} takes no language parameter; drop --language`);
  }
  if (input.style && !capability.style) {
    problems.push(
      `${label} takes no delivery style; drop --style or pick a model with style support`,
    );
  }
  if (input.emotion) {
    if (!capability.emotions) {
      problems.push(
        `${label} has no emotion parameter${capability.style ? "; describe it with --style instead" : ""}`,
      );
    } else if (!capability.emotions.includes(input.emotion)) {
      problems.push(
        `${label} emotion must be one of: ${capability.emotions.join(", ")} (got "${input.emotion}")`,
      );
    }
  }
  const format = input.format ?? capability.formats?.[0];
  if (input.format && capability.formats && !capability.formats.includes(input.format)) {
    problems.push(`${label} writes ${capability.formats.join("|")}, not ${input.format}`);
  }
  if (input.async && !capability.async) {
    problems.push(`${label} returns audio in the same request; drop --async`);
  }
  let extras: Record<string, string | number | boolean> = {};
  try {
    extras = extrasFor(provider, input.extras);
  } catch (error) {
    problems.push((error as Error).message);
  }
  const speed = extras.speed;
  if (
    provider === "openrouter" &&
    typeof speed === "number" &&
    (speed <= 0 || speed > OPENROUTER_MAX_SPEED)
  ) {
    problems.push(
      `--extra openrouter.speed must be greater than 0 and at most ${OPENROUTER_MAX_SPEED} (got ${speed})`,
    );
  }
  if (problems.length > 0) throw new ValidationError(problems.join("; "));
  return {
    provider,
    model,
    ...(voice ? { voice } : {}),
    voice_defaulted: !multi && requested === undefined && Boolean(voice),
    ...(format ? { format } : {}),
    capability,
    extras,
  };
}

/** Extras whose namespace names no route of this request (likely a typo). */
export function unusedExtras(input: SpeechInput, routes: SpeechRoute[]): string[] {
  const used = new Set(routes.map((r) => r.provider));
  return Object.keys(input.extras).filter((name) => {
    const ns = name.split(".")[0] ?? "";
    return !used.has(ns as SpeechProvider);
  });
}

/**
 * The primary route plus the fallbacks the caller listed, all validated now:
 * a fallback is taken only when the primary cannot start (its key is
 * missing), never after a provider was paid, so it must already be valid.
 */
export function planSpeechRoutes(opts: {
  provider?: string;
  model?: string;
  fallbacks: string[];
  input: SpeechInput;
  defaultModel: (provider: SpeechProvider) => string;
}): { routes: SpeechRoute[]; inferred: boolean } {
  const target = resolveTarget(opts.provider, opts.model, opts.defaultModel);
  const routes = [buildRoute(target, opts.input)];
  for (const spec of opts.fallbacks) {
    const parsed = parseRouteSpec(spec);
    const provider = requireProvider(parsed.provider);
    // Voices are provider-specific: another provider gets its own default unless the spec names one.
    const input = provider === target.provider ? opts.input : { ...opts.input, voice: undefined };
    const route = buildRoute(
      { provider, model: parsed.model ?? opts.defaultModel(provider), voice: parsed.voice },
      input,
    );
    if (routes.some((r) => r.provider === route.provider && r.model === route.model)) {
      throw new ValidationError(`--fallback ${spec} repeats a route already in the plan`);
    }
    routes.push(route);
  }
  const stray = unusedExtras(opts.input, routes);
  if (stray.length > 0) {
    throw new ValidationError(
      `--extra ${stray.join(", ")} names a provider this request does not use (${routes.map((r) => r.provider).join(", ")})`,
    );
  }
  return { routes, inferred: target.inferred };
}

/** Format implied by an output file name, when it is one the façade names. */
export function formatFromOutput(output: string | undefined): SpeechFormat | undefined {
  const ext = output?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return ext && isSpeechFormat(ext) ? ext : undefined;
}

/** `--format`, reconciled with the `--output` extension. */
export function resolveFormat(
  format: string | undefined,
  output: string | undefined,
): SpeechFormat | undefined {
  if (format !== undefined && !isSpeechFormat(format)) {
    throw new ValidationError(`--format must be one of: ${SPEECH_FORMATS.join(", ")}`);
  }
  const fromOutput = formatFromOutput(output);
  const ext = output?.match(/\.([A-Za-z0-9]+)$/)?.[1];
  if (ext && !fromOutput) {
    throw new ValidationError(
      `--output ${output}: .${ext} is not an audio container multix speech writes (${SPEECH_FORMATS.join(", ")})`,
    );
  }
  if (format && fromOutput && format !== fromOutput) {
    throw new ValidationError(
      `--format ${format} does not match --output ${output}; use a .${format} file name`,
    );
  }
  return (format as SpeechFormat | undefined) ?? fromOutput;
}

/** What a route differs in from the primary, for the fallback warning. */
export function fallbackDifferences(from: SpeechRoute, to: SpeechRoute): string {
  const parts = [
    `voice ${from.voice ?? "(speakers)"} → ${to.voice ?? "(speakers)"}`,
    `billing ${SPEECH_PROVIDER_INFO[to.provider].billing}`,
  ];
  if (from.format !== to.format)
    parts.push(`format ${from.format ?? "auto"} → ${to.format ?? "auto"}`);
  return parts.join("; ");
}
