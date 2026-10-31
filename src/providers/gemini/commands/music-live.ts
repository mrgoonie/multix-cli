/**
 * multix gemini music-live — record a Lyria RealTime session to WAV, headless.
 *
 * Lyria RealTime (`lyria-realtime-exp`, experimental) streams instrumental
 * music only (no vocals) as 16-bit PCM, 48 kHz stereo, over a WebSocket.
 * Steer it with weighted prompts (--prompt, repeatable, or --prompts-file)
 * and the documented controls; a prompts file can also schedule prompt or
 * config changes at points in the recording. The session ends after
 * --duration seconds of audio, on Ctrl-C (the WAV is finalised), or when the
 * server closes it; it is never restarted on its own.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { recordGeminiMusicLive } from "../generators/music-live.js";
import {
  LYRIA_REALTIME_MODEL,
  type MusicGenerationConfig,
  REALTIME_MAX_SECONDS,
  REALTIME_MODES,
  REALTIME_SCALES,
  type SessionPlan,
  type WeightedPrompt,
  parsePromptsFile,
  validateSessionPlan,
} from "../lyria-realtime.js";

const MAX_PROMPTS_FILE_BYTES = 256 * 1024;

interface MusicLiveFlags {
  prompt: string[];
  weight: string[];
  promptsFile?: string;
  model?: string;
  duration: string;
  bpm?: string;
  density?: string;
  brightness?: string;
  guidance?: string;
  temperature?: string;
  topK?: string;
  seed?: string;
  scale?: string;
  mode?: string;
  muteBass?: boolean;
  muteDrums?: boolean;
  onlyBassAndDrums?: boolean;
  output?: string;
  verbose?: boolean;
}

const collect = (value: string, prev: string[]) => [...prev, value];

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) {
    throw new ValidationError(`${flag} must be a number (got "${value}")`);
  }
  return n;
}

/** Config from the flags; ranges are checked with the rest of the plan. */
function configFromFlags(opts: MusicLiveFlags): MusicGenerationConfig | undefined {
  const config: Record<string, unknown> = {
    bpm: num(opts.bpm, "--bpm"),
    density: num(opts.density, "--density"),
    brightness: num(opts.brightness, "--brightness"),
    guidance: num(opts.guidance, "--guidance"),
    temperature: num(opts.temperature, "--temperature"),
    topK: num(opts.topK, "--top-k"),
    seed: num(opts.seed, "--seed"),
    scale: opts.scale,
    musicGenerationMode: opts.mode,
    muteBass: opts.muteBass,
    muteDrums: opts.muteDrums,
    onlyBassAndDrums: opts.onlyBassAndDrums,
  };
  const set = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  return Object.keys(set).length > 0 ? (set as MusicGenerationConfig) : undefined;
}

function readPromptsFile(file: string): unknown {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ValidationError(`--prompts-file not found: ${file}`);
  if (stat.size > MAX_PROMPTS_FILE_BYTES) {
    throw new ValidationError(`--prompts-file is larger than 256 KB: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new ValidationError(`--prompts-file is not valid JSON: ${(e as Error).message}`);
  }
}

/** Build and validate the session plan from the flags and an optional prompts file. */
export function planFromFlags(opts: MusicLiveFlags): SessionPlan {
  const durationSeconds = num(opts.duration, "--duration") ?? 30;
  const flagConfig = configFromFlags(opts);
  if (opts.promptsFile !== undefined) {
    if (opts.prompt.length > 0 || opts.weight.length > 0) {
      throw new ValidationError("Pass the prompts once: --prompt/--weight or --prompts-file");
    }
    const file = parsePromptsFile(readPromptsFile(opts.promptsFile));
    const config = file.config || flagConfig ? { ...file.config, ...flagConfig } : undefined;
    return validateSessionPlan({ ...file, ...(config ? { config } : {}), durationSeconds });
  }
  if (opts.prompt.length === 0) throw new ValidationError("--prompt or --prompts-file is required");
  if (opts.weight.length > 0 && opts.weight.length !== opts.prompt.length) {
    throw new ValidationError("Give one --weight per --prompt, or none (all weigh 1.0)");
  }
  const prompts: WeightedPrompt[] = opts.prompt.map((text, i) => ({
    text,
    weight: num(opts.weight[i], "--weight") ?? 1,
  }));
  return validateSessionPlan({
    prompts,
    ...(flagConfig ? { config: flagConfig } : {}),
    durationSeconds,
  });
}

export function registerGeminiMusicLiveCommand(parent: Command): void {
  parent
    .command("music-live")
    .description(
      "Record instrumental music from Lyria RealTime (experimental, WebSocket) to a WAV file",
    )
    .option("--prompt <text>", "Weighted prompt text (repeatable)", collect, [] as string[])
    .option(
      "--weight <n>",
      "Weight of the matching --prompt (repeatable, default 1.0)",
      collect,
      [] as string[],
    )
    .option(
      "--prompts-file <path>",
      "JSON {prompts:[{text,weight}], config?, changes?:[{at,prompts?,config?}]}",
    )
    .option("--model <id>", `Model (${LYRIA_REALTIME_MODEL})`)
    .option("--duration <seconds>", `Seconds of audio to record (1-${REALTIME_MAX_SECONDS})`, "30")
    .option("--bpm <n>", "Beats per minute (60-200)")
    .option("--density <n>", "Density of notes (0-1)")
    .option("--brightness <n>", "Tonal brightness (0-1)")
    .option("--guidance <n>", "How strictly prompts are followed (0-6, default 4)")
    .option("--temperature <n>", "Randomness (0-3, default 1.1)")
    .option("--top-k <n>", "Top-k sampling (1-1000, default 40)")
    .option("--seed <n>", "Seed (0-2147483647)")
    .option("--scale <scale>", `Musical scale (${REALTIME_SCALES[0]}, …)`)
    .option("--mode <mode>", `Generation mode (${REALTIME_MODES.join("|")})`)
    .option("--mute-bass", "Leave out the bass")
    .option("--mute-drums", "Leave out the drums")
    .option("--only-bass-and-drums", "Bass and drums only")
    .option("--output <path>", "Copy the WAV recording to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: MusicLiveFlags) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      if (opts.model !== undefined && opts.model !== LYRIA_REALTIME_MODEL) {
        throw new ValidationError(`--model must be ${LYRIA_REALTIME_MODEL}`);
      }
      const plan = planFromFlags(opts);
      const result = await recordGeminiMusicLive({ plan, output: opts.output, logger });
      console.log(`\nGenerated music: ${result.generatedAudio}`);
      console.log(`Recorded: ${result.seconds.toFixed(1)}s (${result.reason})`);
      if (result.reason !== "complete") process.exitCode = 1;
    });
}
