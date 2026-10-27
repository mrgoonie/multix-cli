/**
 * multix fish voice-design — candidate voices from a prompt (POST
 * /v1/voice-design, header `model: voice-design-1`). Billed once per
 * successful request ($0.01), however many candidates come back; the request
 * is sent once and never retried. Candidates are saved as WAV files; keep one
 * with `multix fish clone --sample <file>`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { requireFishKey } from "../client.js";
import {
  MAX_DESIGN_CANDIDATES,
  VOICE_DESIGN_MODEL,
  type VoiceDesignBody,
  checkVoiceDesignBody,
  designFishVoice,
} from "../voice-design-client.js";

interface VoiceDesignOptions {
  prompt?: string;
  instruction?: string;
  referenceText?: string;
  language?: string;
  count: string;
  speed?: string;
  steps?: string;
  guidance?: string;
  instructGuidance?: string;
  seed?: string;
  verbose?: boolean;
}

function number(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n))
    throw new ValidationError(`${flag} must be a number`);
  return n;
}

export function registerFishVoiceDesignCommand(parent: Command): void {
  parent
    .command("voice-design")
    .description(
      `Design voices from a prompt (${VOICE_DESIGN_MODEL}, $0.01 per request): saves 1-${MAX_DESIGN_CANDIDATES} WAV candidates`,
    )
    .argument("[prompt]", "Voice description: age, tone, accent, pacing (1-2000 characters)")
    .option("--instruction <text>", "Alias for the prompt argument")
    .option(
      "--reference-text <text>",
      "Line every candidate reads, to compare them (up to 300 characters)",
    )
    .option("--language <code>", "Language hint, e.g. en, zh, ja, vi")
    .option("--count <n>", `Candidates to generate (1-${MAX_DESIGN_CANDIDATES})`, "2")
    .option("--speed <n>", "Speaking speed (above 0, at most 3)")
    .option("--steps <n>", "Diffusion steps (1-128, default 32)")
    .option("--guidance <n>", "How strongly to follow the prompt (default 2)")
    .option("--instruct-guidance <n>", "Instruction guidance scale (default 0)")
    .option("--seed <n>", "Seed that reproduces the same candidates")
    .option("-v, --verbose", "Verbose logging")
    .action(async (promptArg: string | undefined, opts: VoiceDesignOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      if (promptArg !== undefined && opts.instruction !== undefined) {
        throw new ValidationError("Give the prompt once: as the argument or with --instruction");
      }
      const instruction = (promptArg ?? opts.instruction ?? "").trim();
      const body: VoiceDesignBody = {
        instruction,
        n: number(opts.count, "--count"),
        ...(opts.referenceText?.trim() ? { reference_text: opts.referenceText.trim() } : {}),
        ...(opts.language?.trim() ? { language: opts.language.trim() } : {}),
        ...(opts.speed !== undefined ? { speed: number(opts.speed, "--speed") } : {}),
        ...(opts.steps !== undefined ? { num_step: number(opts.steps, "--steps") } : {}),
        ...(opts.guidance !== undefined
          ? { guidance_scale: number(opts.guidance, "--guidance") }
          : {}),
        ...(opts.instructGuidance !== undefined
          ? { instruct_guidance_scale: number(opts.instructGuidance, "--instruct-guidance") }
          : {}),
        ...(opts.seed !== undefined ? { seed: number(opts.seed, "--seed") } : {}),
      };
      checkVoiceDesignBody(body);
      run.requestModel = VOICE_DESIGN_MODEL;
      const plan = {
        provider: "fish",
        model_header_sent: VOICE_DESIGN_MODEL,
        candidates_requested: body.n ?? 2,
        instruction_chars: [...instruction].length,
        price_usd_per_request: 0.01,
      };
      run.data = { ...plan, dry_run: run.dryRun };
      const apiKey = requireFishKey();
      logger.debug(`Fish voice design n=${plan.candidates_requested}`);
      const candidates = await designFishVoice({
        body,
        apiKey,
        maxBytes: maxDownloadBytes(),
        // Billed once per successful request, even when its answer is unusable.
        onAccepted: () =>
          run.postUsage.push({ tokens: {}, metrics: { "request.count": 1 }, ids: [] }),
      });

      const stamp = outputStamp();
      const saved = candidates.map((c) => {
        const ext = c.check.kind && c.check.kind !== "pcm" ? c.check.kind : "wav";
        const dest = path.join(getOutputDir(), `fish_voice_design_${stamp}_${c.index}.${ext}`);
        fs.writeFileSync(dest, c.audio);
        if (!c.check.signature_ok) {
          logger.warn(
            `Candidate ${c.index} is not WAV audio (${c.check.problems.join("; ")}); saved as returned.`,
          );
        }
        return {
          id: c.id,
          index: c.index,
          path: dest,
          bytes: c.audio.byteLength,
          sha256: createHash("sha256").update(c.audio).digest("hex"),
          audio_kind: c.check.kind,
          sample_rate_hz: c.check.sample_rate_hz ?? c.sample_rate_hz,
          duration_s: c.check.duration_s ?? Math.round(c.duration_ms) / 1000,
          language: c.language,
          // A signature lets `fish clone` mark a clone of this audio as designed.
          design_signature: c.signature,
        };
      });
      const result = { ...plan, candidates: saved };
      run.data = result;
      if (run.json) {
        console.log(JSON.stringify(result));
        return;
      }
      for (const c of saved) {
        logger.success(`Candidate ${c.index}: ${c.path} (${c.duration_s}s)`);
      }
      console.log(
        `\nKeep one as a reusable voice: multix fish clone --title "..." --sample ${saved[0]?.path ?? "<file>"} --consent`,
      );
    });
}
