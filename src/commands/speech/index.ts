/**
 * `multix speech` — one interface for text-to-speech across providers.
 *
 *   multix speech models [--language vi] [--provider p] [--ready]
 *   multix speech generate --provider p [--model m] --text-file scene.txt --voice v --output scene.wav
 *
 * Routing is explicit: the provider comes from --provider (or a model id only
 * one provider serves), a fallback only from --fallback, and only when the
 * route before it cannot start because its key is missing, so no request is
 * ever paid twice or silently moved to another voice, price or provider.
 * The provider adapters reuse each provider's own generator; output files,
 * hashes, durations and usage come from the shared `multix.result/v1` runtime.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { ConfigError, ValidationError } from "../../core/errors.js";
import { createLogger } from "../../core/logger.js";
import {
  SPEECH_FORMATS,
  SPEECH_PROVIDERS,
  SPEECH_PROVIDER_INFO,
  type SpeechModel,
  type SpeechProvider,
  isSpeechProvider,
  speechModels,
} from "../../speech/speech-catalog.js";
import {
  SPEECH_REQUEST_SCHEMA,
  SPEECH_RESULT_SCHEMA,
  type SpeakerVoice,
  type SpeechInput,
  type SpeechRoute,
  collectExtra,
  collectSpeaker,
  fallbackDifferences,
  planSpeechRoutes,
  resolveFormat,
} from "../../speech/speech-request.js";
import { groupKeyNames, groupReady } from "../agent/provider-group-keys.js";
import { SPEECH_ADAPTERS } from "./speech-adapters.js";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

interface GenerateOpts {
  provider?: string;
  model?: string;
  text?: string;
  textFile?: string;
  voice?: string;
  speaker: SpeakerVoice[];
  language?: string;
  style?: string;
  emotion?: string;
  format?: string;
  output?: string;
  async?: boolean;
  fallback: string[];
  extra: Record<string, string>;
  verbose?: boolean;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function readText(opts: GenerateOpts): string {
  if (opts.text !== undefined && opts.textFile !== undefined) {
    throw new ValidationError("Pass --text or --text-file, not both");
  }
  let text = opts.text;
  if (opts.textFile !== undefined) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(opts.textFile);
    } catch {
      throw new ValidationError(`--text-file not found: ${opts.textFile}`);
    }
    if (!stat.isFile()) throw new ValidationError(`--text-file is not a file: ${opts.textFile}`);
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      throw new ValidationError(`--text-file is larger than ${MAX_TEXT_FILE_BYTES} bytes`);
    }
    // Speak the text the cost check priced, not a second read of a file that may have changed.
    text =
      run.textFile?.path === opts.textFile
        ? run.textFile.text
        : fs.readFileSync(opts.textFile, "utf8");
  }
  if (!text?.trim())
    throw new ValidationError("Text is required: --text <str> or --text-file <path>");
  return text.trim();
}

function routeView(route: SpeechRoute) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.voice ? { voice: route.voice } : {}),
    ...(route.voice_defaulted ? { voice_defaulted: true } : {}),
    ...(route.format ? { format: route.format } : {}),
  };
}

/** The request as recorded in the result: the text itself is replaced by its size and hash. */
function requestView(input: SpeechInput, routes: SpeechRoute[], opts: GenerateOpts) {
  return {
    schema: SPEECH_REQUEST_SCHEMA,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    text_chars: input.text.length,
    text_sha256: createHash("sha256").update(input.text).digest("hex"),
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.speakers.length ? { speakers: input.speakers } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.style ? { style: input.style } : {}),
    ...(input.emotion ? { emotion: input.emotion } : {}),
    ...(input.format ? { format: input.format } : {}),
    async: input.async,
    ...(Object.keys(input.extras).length ? { extras: input.extras } : {}),
    ...(routes.length > 1 ? { fallbacks: routes.slice(1).map(routeView) } : {}),
  };
}

function registerGenerate(parent: Command): void {
  parent
    .command("generate")
    .description(
      "Text-to-speech on an explicitly chosen provider/model, validated against its capabilities first",
    )
    .option("--provider <name>", `Speech provider (${SPEECH_PROVIDERS.join("|")})`)
    .option(
      "--model <id>",
      "Model id (default: the provider's TTS default; see `multix speech models`)",
    )
    .option("--text <str>", "Text to speak")
    .option("--text-file <path>", "Read the text to speak from a UTF-8 file")
    .option("--voice <id>", "Voice name or id of the chosen provider (default: its default voice)")
    .option(
      "--speaker <name:voice>",
      "Multi-speaker dialogue voice (repeatable; Gemini, max 2; each line starts with `name:`)",
      collectSpeaker,
      [] as SpeakerVoice[],
    )
    .option(
      "--language <code>",
      "Language code, e.g. vi, en, fil (checked against the model's documented list)",
    )
    .option(
      "--style <text>",
      'Delivery direction, e.g. "warm, unhurried" (models with style support)',
    )
    .option("--emotion <name>", "Named emotion (models with an emotion parameter, e.g. MiniMax)")
    .option(
      "--format <fmt>",
      `Audio container (${SPEECH_FORMATS.join("|")}; default: from --output or the model's first)`,
    )
    .option("--output <path>", "Copy the audio to this path (its extension sets --format)")
    .option("--async", "Submit and return the job id (models with async support)")
    .option(
      "--fallback <route>",
      "Opt-in provider:model:voice route (model and voice optional) used only when the routes before it have no API key (repeatable; never after a paid request)",
      collect,
      [] as string[],
    )
    .option(
      "--extra <provider.key=value>",
      "Provider-specific option, e.g. elevenlabs.stability=0.4 (repeatable; see `multix speech models`)",
      collectExtra,
      {} as Record<string, string>,
    )
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: GenerateOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const input: SpeechInput = {
        text: readText(opts),
        ...(opts.voice ? { voice: opts.voice } : {}),
        speakers: opts.speaker,
        ...(opts.language ? { language: opts.language.toLowerCase() } : {}),
        ...(opts.style ? { style: opts.style } : {}),
        ...(opts.emotion ? { emotion: opts.emotion } : {}),
        format: resolveFormat(opts.format, opts.output),
        async: Boolean(opts.async),
        extras: opts.extra,
      };
      const { routes, inferred } = planSpeechRoutes({
        provider: opts.provider,
        model: opts.model,
        fallbacks: opts.fallback,
        input,
        defaultModel: (p) => SPEECH_ADAPTERS[p].defaultModel(),
      });

      // Pick the first route whose key is set; nothing has been sent yet.
      const skipped: Array<{ provider: string; model: string; reason: string }> = [];
      let chosen: SpeechRoute | undefined;
      for (const [i, route] of routes.entries()) {
        try {
          SPEECH_ADAPTERS[route.provider].requireKey();
          chosen = route;
          break;
        } catch (error) {
          if (!(error instanceof ConfigError) || i === routes.length - 1) throw error;
          skipped.push({ provider: route.provider, model: route.model, reason: error.message });
        }
      }
      if (!chosen) throw new ValidationError("No speech route left to try");
      if (chosen.provider === "fal" && input.async && opts.output) {
        // `fal result` saves under --output-dir with the request id as the name; --output would be lost.
        throw new ValidationError(
          "--output cannot be combined with --async on fal; fetch the audio later with the printed `multix fal result` command",
        );
      }
      const primary = routes[0] as SpeechRoute;
      const fallback =
        chosen === primary
          ? undefined
          : {
              from: `${primary.provider}/${primary.model}`,
              reason: skipped.map((s) => s.reason).join("; "),
              differences: fallbackDifferences(primary, chosen),
            };
      if (fallback) {
        logger.warn(
          `Falling back from ${fallback.from} to ${chosen.provider}/${chosen.model} (--fallback): ${fallback.reason}. Differences: ${fallback.differences}`,
        );
      }

      run.group = chosen.provider;
      run.requestModel = chosen.model;
      const result = {
        schema: SPEECH_RESULT_SCHEMA,
        request: requestView(input, routes, opts),
        route: { ...routeView(chosen), ...(inferred ? { provider_inferred: true } : {}) },
        ...(fallback ? { fallback } : {}),
      };
      // A dry run stops at the first request; the plan is what it reports.
      run.data = result;
      logger.debug(
        `Route: ${chosen.provider}/${chosen.model} voice=${chosen.voice ?? "(speakers)"}`,
      );

      const out = await SPEECH_ADAPTERS[chosen.provider].generate(chosen, input, {
        output: opts.output,
        logger,
        verbose: opts.verbose ?? false,
      });
      run.data = { ...result, files: out.files, ...(out.job ? { job: out.job } : {}) };
      // The provider runner already printed the job id (stdout) and the resume command (stderr).
      if (out.job) return;
      for (const file of out.files) console.log(`Generated audio: ${file}`);
      if (opts.output) console.log(`Copied to: ${opts.output}`);
    });
}

interface ModelsOpts {
  provider?: string;
  language?: string;
  ready?: boolean;
}

function modelRow(m: SpeechModel, defaults: Map<SpeechProvider, string>) {
  const info = SPEECH_PROVIDER_INFO[m.provider];
  const ready = groupReady(m.provider);
  return {
    provider: m.provider,
    model: m.model,
    ...(defaults.get(m.provider) === m.model ? { default: true } : {}),
    ready,
    ...(ready ? {} : { keys: groupKeyNames(m.provider) }),
    languages: m.languages,
    ...(m.language_param ? { language_param: m.language_param } : {}),
    formats: m.formats,
    style: m.style,
    ...(m.emotions ? { emotions: m.emotions } : {}),
    ...(m.max_chars ? { max_chars: m.max_chars } : {}),
    max_speakers: m.max_speakers,
    async: m.async,
    voice: {
      kind: info.voice_kind,
      ...((m.default_voice ?? info.default_voice)
        ? { default: m.default_voice ?? info.default_voice }
        : {}),
      ...(info.voices_command ? { list: info.voices_command } : {}),
    },
    ...(Object.keys(info.extras).length
      ? { extras: Object.keys(info.extras).map((k) => `${m.provider}.${k}`) }
      : {}),
    billing: info.billing,
    source: m.source,
    verified_at: m.verified_at,
  };
}

function registerModels(parent: Command): void {
  parent
    .command("models")
    .description("Speech models with their languages, formats, controls, voices and key readiness")
    .option("-p, --provider <name>", `Only this provider (${SPEECH_PROVIDERS.join("|")})`)
    .option("-l, --language <code>", "Only models that document this language code")
    .option("--ready", "Only providers whose API key is set")
    .action((opts: ModelsOpts) => {
      if (opts.provider && !isSpeechProvider(opts.provider)) {
        throw new ValidationError(
          `Unknown speech provider "${opts.provider}". Valid: ${SPEECH_PROVIDERS.join(", ")}`,
        );
      }
      const language = opts.language?.toLowerCase();
      const defaults = new Map(
        SPEECH_PROVIDERS.map((p) => [p, SPEECH_ADAPTERS[p].defaultModel()] as const),
      );
      const all = speechModels().filter((m) => !opts.provider || m.provider === opts.provider);
      const undocumented = language ? all.filter((m) => m.languages === null) : [];
      const rows = all
        .filter((m) => !language || m.languages?.includes(language))
        .map((m) => modelRow(m, defaults))
        .filter((r) => !opts.ready || r.ready);
      if (run.json) {
        console.log(JSON.stringify(rows));
        return;
      }
      if (rows.length === 0) console.log("No matching speech models.");
      let provider = "";
      for (const r of rows) {
        if (r.provider !== provider) {
          provider = r.provider;
          const v = r.voice;
          console.log(
            `\n${provider}  [${r.ready ? "ready" : `needs ${r.keys?.join(", ")}`}]  voices: ${v.kind}${v.default ? ` (default ${v.default})` : ""}${v.list ? `, list: ${v.list}` : ""}`,
          );
        }
        const traits = [
          r.formats ? r.formats.join("|") : "formats: model-defined",
          r.style ? "style" : "",
          r.emotions ? `emotion: ${r.emotions.join("|")}` : "",
          r.max_speakers > 1 ? `speakers<=${r.max_speakers}` : "",
          r.async ? "async" : "",
          r.languages ? `${r.languages.length} languages` : "languages: undocumented",
          r.language_param ? `--language sent as ${r.language_param}` : "",
        ].filter(Boolean);
        console.log(`  ${r.model}${r.default ? " (default)" : ""}  ${traits.join(", ")}`);
      }
      if (undocumented.length > 0) {
        console.log(
          `\n${undocumented.length} model(s) with no documented language list hidden: ${undocumented.map((m) => `${m.provider}/${m.model}`).join(", ")}`,
        );
      }
      console.log(
        "\nGenerate: multix speech generate --provider <p> --model <m> --text-file <file> --output <file.ext>",
      );
    });
}

export function registerSpeechCommands(program: Command): void {
  const speech = program
    .command("speech")
    .description("Text-to-speech across providers with one request shape and explicit routing");
  registerModels(speech);
  registerGenerate(speech);
}
