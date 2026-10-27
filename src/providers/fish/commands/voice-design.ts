/**
 * multix fish voice-design — describe a voice in words and get 1 to 4
 * candidate voices as WAV files (POST /v1/voice-design, model voice-design-1).
 * One request is billed once, however many candidates it returns, and is never
 * retried. Fish keeps nothing: clone the candidate you like with
 * `fish voices create --sample <wav>` to get a reusable voice id.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { estimateCost } from "../../../budget/cost-estimate.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { checkFishAudio } from "../audio-check.js";
import { requireFishKey } from "../client.js";
import { FISH_VOICE_DESIGN_MODEL } from "../models.js";
import {
  FISH_VOICE_DESIGN_MAX_CANDIDATES,
  type FishVoiceDesignInput,
  createFishVoiceDesign,
  planFishVoiceDesign,
} from "../voice-design.js";

export interface FishVoiceDesignOptions {
  instruction?: string;
  prompt?: string;
  referenceText?: string;
  language?: string;
  count?: string;
  speed?: string;
  numStep?: string;
  guidanceScale?: string;
  instructGuidanceScale?: string;
  seed?: string;
  verbose?: boolean;
}

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) {
    throw new ValidationError(`${flag} must be a number`);
  }
  return n;
}

/** The validated input; nothing is sent. */
export function fishVoiceDesignInput(opts: FishVoiceDesignOptions): FishVoiceDesignInput {
  if (opts.instruction !== undefined && opts.prompt !== undefined) {
    throw new ValidationError("--instruction and --prompt are the same flag: give only one");
  }
  const instruction = opts.instruction ?? opts.prompt;
  if (instruction === undefined) {
    throw new ValidationError("Describe the voice with --instruction");
  }
  const input: FishVoiceDesignInput = { instruction };
  if (opts.referenceText !== undefined) input.referenceText = opts.referenceText;
  if (opts.language !== undefined) input.language = opts.language;
  const fields: Array<[keyof FishVoiceDesignInput, string | undefined, string]> = [
    ["count", opts.count, "--count"],
    ["speed", opts.speed, "--speed"],
    ["numStep", opts.numStep, "--num-step"],
    ["guidanceScale", opts.guidanceScale, "--guidance-scale"],
    ["instructGuidanceScale", opts.instructGuidanceScale, "--instruct-guidance-scale"],
    ["seed", opts.seed, "--seed"],
  ];
  for (const [key, value, flag] of fields) {
    const n = num(value, flag);
    if (n !== undefined) (input as unknown as Record<string, number>)[key] = n;
  }
  planFishVoiceDesign(input);
  return input;
}

export interface FishVoiceDesignCandidateResult {
  index: number;
  id: string | null;
  path: string | null;
  bytes: number | null;
  sha256: string | null;
  /** True when the bytes are a WAV file. */
  signature_ok: boolean;
  sample_rate_hz: number | null;
  duration_s: number | null;
  /** Pass to `fish voices create --voice-design-signature` when Fish returns one. */
  signature: string | null;
  problems: string[];
}

export interface FishVoiceDesignRunResult {
  provider: "fish";
  model_header_sent: typeof FISH_VOICE_DESIGN_MODEL;
  instruction_chars: number;
  instruction_sha256: string;
  candidates_requested: number | null;
  candidates: FishVoiceDesignCandidateResult[];
  estimated_cost_usd: number | null;
  rate_id: string | null;
  warnings: string[];
}

/** Send one /v1/voice-design request and save each usable candidate as WAV. */
export async function runFishVoiceDesign(
  input: FishVoiceDesignInput,
): Promise<FishVoiceDesignRunResult> {
  const body = planFishVoiceDesign(input);
  const apiKey = requireFishKey();
  const design = await createFishVoiceDesign({
    apiKey,
    body,
    // Base64 inflates the audio by a third; leave room for every candidate.
    maxBytes:
      Math.ceil((maxDownloadBytes() * FISH_VOICE_DESIGN_MAX_CANDIDATES * 4) / 3) + 64 * 1024,
    maxCandidateBytes: maxDownloadBytes(),
  });
  const stamp = outputStamp();
  const warnings: string[] = [];
  const candidates = design.candidates.map((c, i): FishVoiceDesignCandidateResult => {
    const problems = c.problem ? [c.problem] : [];
    if (!c.audio) {
      return {
        index: c.index,
        id: c.id,
        path: null,
        bytes: null,
        sha256: null,
        signature_ok: false,
        sample_rate_hz: null,
        duration_s: null,
        signature: c.signature,
        problems,
      };
    }
    const rate = c.sample_rate ?? checkFishAudio(c.audio, "wav", 0).sample_rate_hz ?? 0;
    const check = checkFishAudio(c.audio, "wav", rate);
    problems.push(...check.problems);
    // Name by response order: Fish's own index may repeat or skip.
    const dest = path.join(getOutputDir(), `fish_voice_design_${stamp}_${i + 1}.wav`);
    fs.writeFileSync(dest, c.audio);
    return {
      index: c.index,
      id: c.id,
      path: dest,
      bytes: c.audio.byteLength,
      sha256: createHash("sha256").update(c.audio).digest("hex"),
      signature_ok: check.signature_ok,
      sample_rate_hz: check.sample_rate_hz,
      duration_s: check.duration_s ?? (c.duration_ms !== null ? c.duration_ms / 1000 : null),
      signature: c.signature,
      problems,
    };
  });
  for (const c of candidates) {
    for (const p of c.problems) warnings.push(`candidate ${c.index}: ${p}`);
  }
  const estimate = estimateCost({
    provider: "fish",
    model: FISH_VOICE_DESIGN_MODEL,
    text: body.instruction,
  });
  const result: FishVoiceDesignRunResult = {
    provider: "fish",
    model_header_sent: design.modelHeaderSent,
    instruction_chars: [...body.instruction].length,
    instruction_sha256: createHash("sha256").update(body.instruction).digest("hex"),
    candidates_requested: body.n ?? null,
    candidates,
    estimated_cost_usd: estimate.status === "estimated" ? estimate.expected_usd : null,
    rate_id: estimate.rate?.id ?? null,
    warnings,
  };
  if (!candidates.some((c) => c.signature_ok)) {
    throw new ProviderError(
      `Fish Audio voice design returned no usable WAV candidate (${warnings.join("; ") || "no audio"}); the request is still billed. Saved: ${
        candidates
          .map((c) => c.path)
          .filter(Boolean)
          .join(", ") || "nothing"
      }`,
      "fish",
    );
  }
  return result;
}

export function registerFishVoiceDesignCommand(parent: Command): void {
  parent
    .command("voice-design")
    .description(
      "Design a voice from a text description: 1 to 4 candidate WAVs ($0.01 per request; clone one with `fish voices create`)",
    )
    .option("--instruction <text>", "Describe the voice (1 to 2000 characters)")
    .option("--prompt <text>", "Alias for --instruction")
    .option(
      "--reference-text <text>",
      "Line every candidate reads, to compare them (short; Fish rejects long text)",
    )
    .option("--language <bcp47>", "Language hint (en, zh, ja, vi, ...)")
    .option(
      "--count <n>",
      `Candidates to generate, 1 to ${FISH_VOICE_DESIGN_MAX_CANDIDATES} (Fish default 2)`,
    )
    .option("--speed <n>", "Speaking speed multiplier, above 0 up to 3 (default 1)")
    .option("--num-step <n>", "Diffusion steps, 1 to 128 (default 32)")
    .option("--guidance-scale <n>", "How closely to follow the description, 0 or more (default 2)")
    .option("--instruct-guidance-scale <n>", "Instruction guidance, 0 or more (default 0)")
    .option("--seed <n>", "Seed to reproduce a generation")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: FishVoiceDesignOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const input = fishVoiceDesignInput(opts);
      run.requestModel = FISH_VOICE_DESIGN_MODEL;
      const result = await runFishVoiceDesign(input);
      if (run.json) {
        console.log(JSON.stringify(result));
        return;
      }
      for (const w of result.warnings) logger.warn(w);
      for (const c of result.candidates) {
        if (!c.path) continue;
        const details = [
          c.duration_s !== null ? `${c.duration_s}s` : "",
          c.sample_rate_hz ? `${c.sample_rate_hz} Hz` : "",
        ].filter(Boolean);
        logger.success(
          `Candidate ${c.index}: ${c.path}${details.length ? ` (${details.join(", ")})` : ""}`,
        );
      }
      console.log(
        "\nKeep one with: multix fish voices create --title <name> --sample <wav> --consent",
      );
    });
}
