/**
 * multix gemini music-live — record real-time instrumental music from Lyria
 * RealTime (`lyria-realtime-exp`) to a WAV file.
 *
 * Headless: prompts and config come from flags and an optional timeline file
 * (`--prompts-file`) whose steps change prompts/config `at` N seconds into the
 * recording. Recording stops after `--duration` seconds of audio, on
 * Ctrl-C/SIGTERM (the partial file stays valid), when the server closes, or on
 * a timeout. PCM is streamed to disk as it arrives and the WAV header is
 * patched on finalize. The connection is never re-opened automatically: a new
 * session would bill and record again.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ConfigError, MultixError, ProviderError, ValidationError } from "../../../core/errors.js";
import { guardExternalRun } from "../../../core/external-run-guard.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { wrapPcmInWav } from "../generators/speech.js";
import { withGeminiKey } from "../key-pool.js";
import {
  LYRIA_BITS_PER_SAMPLE,
  LYRIA_DEFAULT_DURATION_SEC,
  LYRIA_MAX_DURATION_SEC,
  LYRIA_MODES,
  LYRIA_REALTIME_MODEL,
  LYRIA_REALTIME_MODELS,
  LYRIA_SCALES,
  type LyriaLiveResult,
  type LyriaMusicConfig,
  type LyriaSocketFactory,
  type LyriaTimeline,
  type PcmFormat,
  type WeightedPrompt,
  buildLyriaPlan,
  lyriaSetupMessage,
  parseLyriaTimeline,
  runLyriaLiveSession,
  validateLyriaConfig,
  validateWeightedPrompt,
} from "../lyria-live.js";

export interface MusicLiveOptions {
  prompt: string[];
  weightedPrompt: string[];
  promptsFile?: string;
  duration: string;
  bpm?: string;
  density?: string;
  brightness?: string;
  scale?: string;
  guidance?: string;
  temperature?: string;
  topK?: string;
  seed?: string;
  muteBass?: boolean;
  muteDrums?: boolean;
  onlyBassAndDrums?: boolean;
  mode?: string;
  model?: string;
  output?: string;
  verbose?: boolean;
}

/** Test seams; production uses the global WebSocket and process signals. */
export interface MusicLiveDeps {
  createSocket?: LyriaSocketFactory;
  /** Extra stop signal (tests); SIGINT/SIGTERM are always wired too. */
  signal?: AbortSignal;
  setupTimeoutMs?: number;
  idleTimeoutMs?: number;
  logger?: Logger;
}

export interface MusicLiveResult {
  path: string;
  seconds: number;
  endReason: LyriaLiveResult["endReason"];
}

export function registerGeminiMusicLiveCommand(parent: Command): void {
  parent
    .command("music-live")
    .description(
      "Record real-time instrumental music from Lyria RealTime (experimental, Node 22+) to WAV",
    )
    .option("--prompt <text>", "Music prompt, weight 1.0 (repeatable)", collect, [] as string[])
    .option(
      "--weighted-prompt <text:weight>",
      'Prompt with a non-zero weight after the last colon, e.g. "warm pads:0.5" (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      "--prompts-file <path>",
      'JSON timeline {"steps":[{"at":<sec>,"prompts":[{"text","weight"}],"config":{...}}]}',
    )
    .option(
      "--duration <seconds>",
      `Seconds of audio to record (max ${LYRIA_MAX_DURATION_SEC})`,
      String(LYRIA_DEFAULT_DURATION_SEC),
    )
    .option("--bpm <n>", "Beats per minute, integer 60-200")
    .option("--density <n>", "Note density 0.0-1.0")
    .option("--brightness <n>", "Tonal brightness 0.0-1.0")
    .option("--scale <name>", `Musical scale (${LYRIA_SCALES.join("|")})`)
    .option("--guidance <n>", "Prompt adherence 0.0-6.0 (server default 4.0)")
    .option("--temperature <n>", "Sampling temperature 0.0-3.0 (server default 1.1)")
    .option("--top-k <n>", "Top-k sampling, integer 1-1000 (server default 40)")
    .option("--seed <n>", "Seed, integer 0-2147483647")
    .option("--mute-bass", "Mute the bass")
    .option("--mute-drums", "Mute the drums")
    .option("--only-bass-and-drums", "Only bass and drums")
    .option(
      "--mode <mode>",
      `Generation mode (${LYRIA_MODES.map((m) => m.toLowerCase()).join("|")})`,
    )
    .option("--model <id>", `Model (${[...LYRIA_REALTIME_MODELS].join("|")})`, LYRIA_REALTIME_MODEL)
    .option("--output <path>", "Copy the WAV to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: MusicLiveOptions) => {
      const result = await runMusicLive(opts);
      console.log(`\nGenerated audio: ${result.path}`);
      console.log(`Recorded: ${result.seconds.toFixed(1)}s`);
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** Parse a decimal flag; integers only when `integer` is set. */
function parseNumberFlag(
  flag: string,
  raw: string | undefined,
  integer = false,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const n = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    throw new ValidationError(
      `${flag} must be ${integer ? "an integer" : "a number"} (got "${raw}")`,
    );
  }
  return n;
}

/** `text:weight`, split at the last colon so the text may contain colons. */
export function parseWeightedPromptFlag(value: string): WeightedPrompt {
  const idx = value.lastIndexOf(":");
  const weightRaw = idx > 0 ? value.slice(idx + 1).trim() : "";
  const weight = weightRaw === "" ? Number.NaN : Number(weightRaw);
  if (idx <= 0 || !Number.isFinite(weight)) {
    throw new ValidationError(
      `--weighted-prompt must be "text:weight" with a numeric weight (got "${value}")`,
    );
  }
  return validateWeightedPrompt({ text: value.slice(0, idx), weight }, "--weighted-prompt");
}

export function parseDuration(raw: string): number {
  const n = parseNumberFlag("--duration", raw);
  if (n === undefined || n <= 0 || n > LYRIA_MAX_DURATION_SEC) {
    throw new ValidationError(`--duration must be > 0 and <= ${LYRIA_MAX_DURATION_SEC} seconds`);
  }
  return n;
}

/** Build the music config from flags; ranges are checked by the shared schema. */
export function configFromFlags(opts: MusicLiveOptions): LyriaMusicConfig {
  const config: Record<string, unknown> = {
    bpm: parseNumberFlag("--bpm", opts.bpm, true),
    density: parseNumberFlag("--density", opts.density),
    brightness: parseNumberFlag("--brightness", opts.brightness),
    guidance: parseNumberFlag("--guidance", opts.guidance),
    temperature: parseNumberFlag("--temperature", opts.temperature),
    topK: parseNumberFlag("--top-k", opts.topK, true),
    seed: parseNumberFlag("--seed", opts.seed, true),
    scale: opts.scale?.trim().toUpperCase(),
    musicGenerationMode: opts.mode?.trim().toUpperCase(),
    muteBass: opts.muteBass ? true : undefined,
    muteDrums: opts.muteDrums ? true : undefined,
    onlyBassAndDrums: opts.onlyBassAndDrums ? true : undefined,
  };
  for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
  // Error paths name the JSON field; map them back to the flag the user typed.
  try {
    return validateLyriaConfig(config, "options");
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const flagNames: Record<string, string> = {
      topK: "--top-k",
      musicGenerationMode: "--mode",
      bpm: "--bpm",
      density: "--density",
      brightness: "--brightness",
      guidance: "--guidance",
      temperature: "--temperature",
      seed: "--seed",
      scale: "--scale",
    };
    const message = e.message.replace(/\b(\w+):/g, (m, key: string) =>
      flagNames[key] ? `${flagNames[key]}:` : m,
    );
    throw new ValidationError(message);
  }
}

function readTimeline(file: string, durationSec: number): LyriaTimeline {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new ValidationError(
      `Cannot read --prompts-file ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ValidationError(
      `--prompts-file ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseLyriaTimeline(json, durationSec);
}

/** Streams PCM into a WAV file: placeholder header first, sizes patched on finalize. */
class WavStreamWriter {
  private dataBytes = 0;

  private constructor(
    readonly file: string,
    private readonly handle: fs.promises.FileHandle,
    private readonly format: PcmFormat,
  ) {}

  static async create(file: string, format: PcmFormat): Promise<WavStreamWriter> {
    fs.writeFileSync(file, wavHeader(0, format));
    const handle = await fs.promises.open(file, "r+");
    return new WavStreamWriter(file, handle, format);
  }

  async append(pcm: Uint8Array): Promise<void> {
    const { bytesWritten } = await this.handle.write(pcm, 0, pcm.length, 44 + this.dataBytes);
    this.dataBytes += bytesWritten;
  }

  /** Patch the RIFF and data sizes, drop a trailing partial frame, and close. */
  async finalize(): Promise<number> {
    try {
      const frame = this.format.channels * (LYRIA_BITS_PER_SAMPLE / 8);
      const aligned = this.dataBytes - (this.dataBytes % frame);
      if (aligned !== this.dataBytes) await this.handle.truncate(44 + aligned);
      this.dataBytes = aligned;
      await this.handle.write(wavHeader(aligned, this.format), 0, 44, 0);
    } finally {
      await this.handle.close();
    }
    return this.dataBytes;
  }
}

function wavHeader(dataBytes: number, format: PcmFormat): Buffer {
  const header = wrapPcmInWav(
    Buffer.alloc(0),
    format.sampleRate,
    format.channels,
    LYRIA_BITS_PER_SAMPLE,
  );
  header.writeUInt32LE(36 + dataBytes, 4);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function globalSocketFactory(): LyriaSocketFactory {
  const WS = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (typeof WS !== "function") {
    throw new ConfigError("gemini music-live needs Node 22 or newer (built-in WebSocket)");
  }
  // The WHATWG WebSocket satisfies LyriaSocket; the global is typed loosely
  // above because Node 20 typings may declare it while the runtime lacks it.
  return (url) => new WS(url) as ReturnType<LyriaSocketFactory>;
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Validate, connect, record, and save. Throws on validation errors or when no audio arrived. */
export async function runMusicLive(
  opts: MusicLiveOptions,
  deps: MusicLiveDeps = {},
): Promise<MusicLiveResult> {
  const logger = deps.logger ?? createLogger({ verbose: opts.verbose ?? false });

  const model = opts.model ?? LYRIA_REALTIME_MODEL;
  if (!LYRIA_REALTIME_MODELS.has(model)) {
    throw new ValidationError(`--model must be one of: ${[...LYRIA_REALTIME_MODELS].join(", ")}`);
  }
  const durationSec = parseDuration(opts.duration);
  const flagPrompts = [
    ...opts.prompt.map((text) => validateWeightedPrompt({ text, weight: 1 }, "--prompt")),
    ...opts.weightedPrompt.map(parseWeightedPromptFlag),
  ];
  const config = configFromFlags(opts);
  const timeline = opts.promptsFile ? readTimeline(opts.promptsFile, durationSec) : undefined;
  const plan = buildLyriaPlan(flagPrompts, config, timeline);
  const openSocket = deps.createSocket ?? globalSocketFactory();
  // fetch telemetry never sees a WebSocket, so a --dry-run stops here, before connecting.
  const createSocket: LyriaSocketFactory = (url) => {
    guardExternalRun({
      method: "WEBSOCKET",
      program: url.replace(/\?.*$/, ""),
      args: [lyriaSetupMessage(model)],
    });
    return openSocket(url);
  };

  const dest = path.join(getOutputDir(), `gemini_music_live_${outputStamp()}.wav`);
  let writer: WavStreamWriter | undefined;

  const controller = new AbortController();
  const onSignal = (signal: string) => {
    logger.warn(`${signal} received; stopping and saving the recording`);
    controller.abort();
  };
  const onExternalAbort = () => controller.abort();
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener("abort", onExternalAbort, { once: true });

  logger.info(
    `Lyria RealTime (${model}, experimental, cost not published): recording up to ${durationSec}s; Ctrl-C stops early`,
  );

  let result: LyriaLiveResult;
  let dataBytes = 0;
  try {
    result = await withGeminiKey(
      (apiKey) =>
        runLyriaLiveSession({
          apiKey,
          model,
          plan,
          durationSec,
          createSocket,
          signal: controller.signal,
          setupTimeoutMs: deps.setupTimeoutMs,
          idleTimeoutMs: deps.idleTimeoutMs,
          logger,
          onWarning: (message) => logger.warn(message),
          onAudio: async (pcm, format) => {
            writer ??= await WavStreamWriter.create(dest, format);
            await writer.append(pcm);
          },
        }),
      { logger },
    );
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
    deps.signal?.removeEventListener("abort", onExternalAbort);
    if (writer) dataBytes = await writer.finalize();
  }

  if (!writer || dataBytes === 0 || !result.format) {
    if (writer) fs.rmSync(dest, { force: true });
    if (result.endReason === "aborted") {
      throw new MultixError("Stopped before Lyria sent any audio; nothing was saved", "CANCELLED");
    }
    throw result.error ?? new ProviderError("Lyria returned no audio; nothing was saved", "gemini");
  }

  const seconds = dataBytes / (result.format.sampleRate * result.format.channels * 2);
  if (result.error) {
    logger.warn(`Recording ended early: ${result.error.message}. Kept ${seconds.toFixed(1)}s`);
  } else if (result.endReason === "server-closed") {
    logger.warn(`Lyria closed the session after ${seconds.toFixed(1)}s`);
  }
  if (result.filteredPrompts > 0) {
    logger.warn(`${result.filteredPrompts} prompt(s) were filtered by Lyria safety checks`);
  }
  logger.success(`Saved: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);

  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(dest, opts.output);
    logger.success(`Copied to: ${opts.output}`);
  }
  return { path: dest, seconds, endReason: result.endReason };
}
