/**
 * multix fish tts — native Fish Audio text-to-speech (POST /v1/tts), Drama 3
 * by default. The model goes in the exact `model` header from an allowlist:
 * Fish serves any other value (or none) as s2.1-pro and still answers 200, so
 * the result records the header that was sent and says the response does not
 * confirm it. The audio is checked (container, sample rate, duration, SHA-256)
 * before the run reports success. The request is sent once, never retried.
 * Text is never logged, only its length and hash.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { probeDuration } from "../../../agent/output-file-inspect.js";
import { run } from "../../../agent/run-state.js";
import { estimateCost } from "../../../budget/cost-estimate.js";
import { envDefault } from "../../../core/env-default.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { type AudioCheck, checkFishAudio } from "../audio-check.js";
import { requireFishKey } from "../client.js";
import {
  DEFAULT_FISH_TTS_MODEL,
  FISH_LATENCIES,
  FISH_SERVER_DEFAULT_MODEL,
  FISH_TTS_FORMATS,
  FISH_TTS_MODELS,
  FISH_TTS_MODEL_ENV,
  type FishTtsFormat,
  type FishTtsModel,
  fishSampleRate,
  isFishTtsModel,
} from "../models.js";
import { createFishSpeech } from "../tts-client.js";
import {
  type FishTtsInput,
  type PronunciationDictionaries,
  parseDictionaryRef,
  planFishTts,
  turnsToSpeakerText,
  validateDictionaries,
} from "../tts-request.js";

/** Same cap as `speech generate --text-file`. */
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TURNS = 200;

export interface FishTtsOptions {
  text?: string;
  prompt?: string;
  textFile?: string;
  turnsFile?: string;
  model?: string;
  voice?: string[];
  format: string;
  sampleRate?: string;
  mp3Bitrate?: string;
  opusBitrate?: string;
  temperature?: string;
  topP?: string;
  speed?: string;
  volume?: string;
  normalizeLoudness?: boolean;
  chunkLength?: string;
  normalize?: boolean;
  language?: string;
  latency?: string;
  dictionary?: string[];
  dictionaryFile?: string;
  output?: string;
  verbose?: boolean;
}

export function parseFishModel(value: string): FishTtsModel {
  const model = value.trim();
  if (!isFishTtsModel(model)) {
    throw new ValidationError(
      `--model must be one of ${FISH_TTS_MODELS.join(", ")} (exact spelling; Fish bills any other value as ${FISH_SERVER_DEFAULT_MODEL}), got "${value}"`,
    );
  }
  return model;
}

export function parseFishFormat(value: string): FishTtsFormat {
  const format = value.trim().toLowerCase();
  if (!(FISH_TTS_FORMATS as readonly string[]).includes(format)) {
    throw new ValidationError(`--format must be one of ${FISH_TTS_FORMATS.join(", ")}`);
  }
  return format as FishTtsFormat;
}

function readUtf8(file: string, flag: string): string {
  // Reuse the text the cost check priced, not a second read of a file that may have changed.
  if (flag !== "--dictionary-file" && run.textFile?.path === file) {
    return run.textFile.text.replace(/^\uFEFF/, "");
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`${flag} file not found: ${file}`);
  }
  if (fs.statSync(resolved).size > MAX_TEXT_FILE_BYTES) {
    throw new ValidationError(`${flag} is larger than ${MAX_TEXT_FILE_BYTES} bytes`);
  }
  return fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
}

/** Turns from JSON: `[{"text": "...", "voice": "<voice id>"}]`, one voice per turn. */
export function parseFishTurns(raw: string): Array<{ text: string; voice: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('--turns-file must be a JSON array of {"text", "voice"}');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_TURNS) {
    throw new ValidationError(`--turns-file must be a JSON array of 1 to ${MAX_TURNS} turns`);
  }
  return parsed.map((item, i) => {
    const t = item as Record<string, unknown> | null;
    if (!t || typeof t.text !== "string" || t.text.trim() === "") {
      throw new ValidationError(`--turns-file turn ${i + 1} needs a non-empty "text" string`);
    }
    if (typeof t.voice !== "string" || t.voice.trim() === "") {
      throw new ValidationError(
        `--turns-file turn ${i + 1} needs a "voice" (Fish voice id or adrian, delia, sheila)`,
      );
    }
    return { text: t.text, voice: t.voice };
  });
}

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n))
    throw new ValidationError(`${flag} must be a number`);
  return n;
}

function int(value: string | undefined, flag: string): number | undefined {
  const n = num(value, flag);
  if (n !== undefined && !Number.isInteger(n)) {
    throw new ValidationError(`${flag} must be a whole number`);
  }
  return n;
}

function dictionaries(opts: FishTtsOptions): PronunciationDictionaries | undefined {
  const refs = opts.dictionary ?? [];
  if (refs.length > 0 && opts.dictionaryFile) {
    throw new ValidationError(
      "--dictionary (published id@version) and --dictionary-file (inline) cannot be combined: Fish rejects a request that mixes both forms",
    );
  }
  if (refs.length > 0) return validateDictionaries(refs.map(parseDictionaryRef));
  if (!opts.dictionaryFile) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readUtf8(opts.dictionaryFile, "--dictionary-file"));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("--dictionary-file must be JSON");
  }
  // One inline dictionary may be given as {items} or a bare items array.
  const list = Array.isArray(parsed)
    ? parsed.every((d) => d && typeof d === "object" && ("items" in d || "id" in d))
      ? parsed
      : [{ items: parsed }]
    : [parsed];
  return validateDictionaries(list);
}

/** Text and voices from --text / --text-file / --turns-file and --voice. */
function textAndVoices(opts: FishTtsOptions): {
  text: string;
  voices: string[];
  turns: number | null;
} {
  if (opts.text !== undefined && opts.prompt !== undefined) {
    throw new ValidationError("--text and --prompt are the same flag: give only one");
  }
  const inline = opts.text ?? opts.prompt;
  const sources = [inline, opts.textFile, opts.turnsFile].filter((v) => v !== undefined);
  if (sources.length === 0) {
    throw new ValidationError("Provide the text with --text, --text-file or --turns-file");
  }
  if (sources.length > 1) {
    throw new ValidationError("--text, --text-file and --turns-file cannot be combined");
  }
  const voices = (opts.voice ?? []).map((v) => v.trim()).filter(Boolean);
  if (opts.turnsFile) {
    if (voices.length > 0) {
      throw new ValidationError("--turns-file names a voice per turn; drop --voice");
    }
    const turns = parseFishTurns(readUtf8(opts.turnsFile, "--turns-file"));
    const tagged = turnsToSpeakerText(turns);
    return { ...tagged, turns: turns.length };
  }
  const text = opts.textFile ? readUtf8(opts.textFile, "--text-file") : (inline ?? "");
  return { text, voices, turns: null };
}

/** The input a `fish tts` run will send; validated, nothing sent. Shared with `speech generate`. */
export function fishTtsInput(opts: FishTtsOptions): {
  input: FishTtsInput;
  turns: number | null;
} {
  const model = parseFishModel(
    opts.model ?? envDefault(FISH_TTS_MODEL_ENV, DEFAULT_FISH_TTS_MODEL),
  );
  const format = parseFishFormat(opts.format);
  const { text, voices, turns } = textAndVoices(opts);
  const dicts = dictionaries(opts);
  return {
    turns,
    input: {
      model,
      text,
      voices,
      format,
      ...(opts.sampleRate !== undefined
        ? { sampleRate: int(opts.sampleRate, "--sample-rate") }
        : {}),
      ...(opts.mp3Bitrate !== undefined
        ? { mp3Bitrate: int(opts.mp3Bitrate, "--mp3-bitrate") }
        : {}),
      ...(opts.opusBitrate !== undefined
        ? { opusBitrate: int(opts.opusBitrate, "--opus-bitrate") }
        : {}),
      ...(opts.temperature !== undefined
        ? { temperature: num(opts.temperature, "--temperature") }
        : {}),
      ...(opts.topP !== undefined ? { topP: num(opts.topP, "--top-p") } : {}),
      ...(opts.speed !== undefined ? { speed: num(opts.speed, "--speed") } : {}),
      ...(opts.volume !== undefined ? { volume: num(opts.volume, "--volume") } : {}),
      ...(opts.normalizeLoudness === false ? { normalizeLoudness: false } : {}),
      ...(opts.chunkLength !== undefined
        ? { chunkLength: int(opts.chunkLength, "--chunk-length") }
        : {}),
      ...(opts.normalize === false ? { normalize: false } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.latency ? { latency: opts.latency } : {}),
      ...(dicts ? { dictionaries: dicts } : {}),
    },
  };
}

function writeAudio(bytes: Uint8Array, ext: string, output: string | undefined): string {
  const dest = path.join(getOutputDir(), `fish_tts_${outputStamp()}.${ext}`);
  fs.writeFileSync(dest, bytes);
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dest, target);
  }
  return dest;
}

const MIME: Record<FishTtsFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
  opus: "audio/ogg",
};

export interface FishTtsResult {
  provider: "fish";
  model_requested: FishTtsModel;
  /** The exact `model` header sent; Fish's response does not name the model that ran. */
  model_header_sent: FishTtsModel;
  model_confirmed_by_response: false;
  voices: string[];
  speakers: number;
  turns: number | null;
  input_chars: number;
  input_utf8_bytes: number;
  text_sha256: string;
  pronunciation_dictionaries: number;
  format: FishTtsFormat;
  mime: string;
  response_mime: string | null;
  bytes: number;
  sha256: string;
  signature_ok: boolean;
  sample_rate_hz: number | null;
  channels: number | null;
  duration_s: number | null;
  duration_source: AudioCheck["duration_source"] | "ffprobe";
  estimated_cost_usd: number | null;
  rate_id: string | null;
  warnings: string[];
  path: string;
  output: string | null;
}

/**
 * Validate, send one /v1/tts request, check and save the audio. Throws
 * ProviderError (after saving the bytes) when they are not the requested audio.
 */
export async function runFishTts(
  input: FishTtsInput,
  ctx: { output?: string; logger: Logger; turns?: number | null },
): Promise<FishTtsResult> {
  const plan = planFishTts(input);
  for (const warning of plan.warnings) ctx.logger.warn(warning);
  const apiKey = requireFishKey();
  ctx.logger.debug(
    `Fish TTS model=${input.model} voices=${input.voices.length} format=${input.format} bytes=${plan.utf8Bytes}`,
  );
  const speech = await createFishSpeech({
    apiKey,
    model: input.model,
    body: plan.body,
    maxBytes: maxDownloadBytes(),
  });
  const check = checkFishAudio(
    speech.audio,
    input.format,
    fishSampleRate(input.format, input.sampleRate),
  );
  const dest = writeAudio(speech.audio, input.format, ctx.output);
  if (!check.signature_ok) {
    throw new ProviderError(
      `Fish Audio answered 200 but the body is not ${input.format} audio (${check.problems.join("; ")}); saved for inspection: ${dest}`,
      "fish",
    );
  }
  for (const problem of check.problems) ctx.logger.warn(`audio check: ${problem}`);
  let duration = check.duration_s;
  let durationSource: FishTtsResult["duration_source"] = check.duration_source;
  if (duration === null) {
    duration = probeDuration(dest) ?? null;
    durationSource = duration !== null ? "ffprobe" : null;
  }
  const estimate = estimateCost({ provider: "fish", model: input.model, text: plan.body.text });
  return {
    provider: "fish",
    model_requested: input.model,
    model_header_sent: speech.modelHeaderSent,
    model_confirmed_by_response: false,
    voices: Array.isArray(plan.body.reference_id)
      ? plan.body.reference_id
      : plan.body.reference_id
        ? [plan.body.reference_id]
        : [],
    speakers: plan.speakers.length,
    turns: ctx.turns ?? null,
    input_chars: [...plan.body.text].length,
    input_utf8_bytes: plan.utf8Bytes,
    text_sha256: createHash("sha256").update(plan.body.text).digest("hex"),
    pronunciation_dictionaries: plan.body.pronunciation_dictionary?.length ?? 0,
    format: input.format,
    mime: MIME[input.format],
    response_mime: speech.mime ?? null,
    bytes: speech.audio.byteLength,
    sha256: createHash("sha256").update(speech.audio).digest("hex"),
    signature_ok: check.signature_ok,
    sample_rate_hz: check.sample_rate_hz,
    channels: check.channels,
    duration_s: duration,
    duration_source: durationSource,
    estimated_cost_usd: estimate.status === "estimated" ? estimate.expected_usd : null,
    rate_id: estimate.rate?.id ?? null,
    warnings: [...plan.warnings, ...check.problems],
    path: dest,
    output: ctx.output ? path.resolve(ctx.output) : null,
  };
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerFishTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description(
      "Text-to-speech with the native Fish Audio API (Drama 3 by default; direction tags, phoneme tags, multi-speaker, pronunciation dictionaries)",
    )
    .option("--text <str>", "Text to speak (Fish tags such as [whispering] are sent as written)")
    .option("--prompt <str>", "Alias for --text")
    .option("--text-file <path>", "Read the text to speak from a UTF-8 file")
    .option(
      "--turns-file <path>",
      'Multi-speaker input: JSON array of {"text", "voice"}, sent as <|speaker:N|> turns',
    )
    .option(
      "--model <id>",
      `Fish TTS model, sent as the exact model header: ${FISH_TTS_MODELS.join(", ")} (env ${FISH_TTS_MODEL_ENV})`,
    )
    .option(
      "--voice <id>",
      "Voice model id (reference_id) or adrian, delia, sheila; repeat once per <|speaker:N|> in index order",
      collect,
    )
    .option("--format <fmt>", `Output ${FISH_TTS_FORMATS.join("|")}`, "mp3")
    .option(
      "--sample-rate <hz>",
      "Sample rate: wav/pcm 8000-44100, mp3 32000|44100 (default 44100; opus is always 48000)",
    )
    .option("--mp3-bitrate <kbps>", "MP3 bitrate: 64, 128 or 192")
    .option("--opus-bitrate <bps>", "Opus bitrate: -1000 (auto), 24000, 32000, 48000, 64000")
    .option("--temperature <n>", "Sampling temperature, 0 to 1")
    .option("--top-p <n>", "Nucleus sampling, 0 to 1")
    .option("--speed <n>", "Speaking rate, 0.5 to 2")
    .option("--volume <db>", "Volume change in dB (0 = unchanged)")
    .option("--no-normalize-loudness", "Turn off loudness normalization (S2 family)")
    .option("--chunk-length <n>", "Characters per synthesis chunk, 100 to 300")
    .option("--no-normalize", "Turn off text normalization (numbers, dates)")
    .option("--language <bcp47>", "Language hint for text normalization (en, vi, es-MX, ...)")
    .option("--latency <mode>", `Latency mode: ${FISH_LATENCIES.join(", ")}`)
    .option(
      "--dictionary <id@version>",
      "Published pronunciation dictionary, pinned to a version id (repeat up to 3)",
      collect,
    )
    .option(
      "--dictionary-file <path>",
      'Pronunciation dictionaries as JSON: inline [{"items":[{"key","value","case_sensitive"?}]}] or published [{"id","version"}]',
    )
    .option("--output <path>", "Copy the generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: FishTtsOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const { input, turns } = fishTtsInput(opts);
      run.requestModel = input.model;
      const result = await runFishTts(input, { output: opts.output, logger, turns });
      if (run.json) {
        console.log(JSON.stringify(result));
        return;
      }
      logger.success(`Saved: ${result.path}`);
      if (result.output) logger.success(`Copied to: ${result.output}`);
      const details = [
        `model header ${result.model_header_sent}`,
        `${result.format}${result.sample_rate_hz ? ` ${result.sample_rate_hz} Hz` : ""}`,
        result.duration_s !== null ? `${result.duration_s}s` : "",
        `${result.input_utf8_bytes} UTF-8 bytes`,
      ].filter(Boolean);
      console.log(`  ${details.join(", ")}`);
      console.log(`\nGenerated audio: ${result.path}`);
    });
}
