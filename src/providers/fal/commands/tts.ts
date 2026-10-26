/**
 * multix fal tts [text] — text-to-speech on any fal TTS endpoint. Known
 * endpoints (see tts-models.ts) get their own field names and are validated
 * before submit; any other id runs untyped. Reuses the `fal run` queue flow:
 * one submit (never retried), `--detach` / `--receipt` receipts, polling, and
 * a download that names the file by what the bytes are and refuses anything
 * that is not audio.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { appIdFromModel, createFalClient } from "../client.js";
import { FAL_DEFAULTS } from "../models.js";
import { type FalReceipt, buildReceipt, persistReceipt } from "../request-receipt.js";
import {
  downloadResultMedia,
  extractMediaRefs,
  parseInputArg,
  submitFalRequest,
  waitForFalResult,
} from "../run-helpers.js";
import { FAL_TTS_PROFILES, buildTtsInput } from "../tts-models.js";
import type { FalSubmitResponse } from "../types.js";

interface TtsOpts {
  model?: string;
  textFile?: string;
  voice?: string;
  style?: string;
  format?: string;
  language?: string;
  textField?: string;
  input?: string;
  detach?: boolean;
  receipt?: string;
  download: boolean;
  outputDir?: string;
  waitTimeout: string;
  verbose?: boolean;
}

/** Text files larger than this are not TTS scripts (every endpoint caps far below). */
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function readTextFile(file: string): string {
  const abs = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ValidationError(`--text-file not found: ${file}`);
  }
  if (!stat.isFile()) throw new ValidationError(`--text-file is not a file: ${file}`);
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new ValidationError(`--text-file is larger than 1 MB: ${file}`);
  }
  const text = fs.readFileSync(abs, "utf8").replace(/^﻿/, "");
  if (!text.trim()) throw new ValidationError(`--text-file is empty: ${file}`);
  return text;
}

export function registerFalTtsCommand(parent: Command): void {
  const typed = FAL_TTS_PROFILES.map((p) => p.id).join("|");
  parent
    .command("tts [text]")
    .description(
      "Text-to-speech on fal.ai with model-specific fields checked before submit (Gemini 3.8 Flash TTS, ElevenLabs v4, or any fal TTS id)",
    )
    .option(
      "-m, --model <id>",
      `fal TTS endpoint (${typed}) default ${FAL_DEFAULTS.ttsModel}; other ids run untyped`,
    )
    .option("--text-file <path>", "Read the text to speak from a UTF-8 file")
    .option(
      "--voice <name>",
      "Voice (Gemini: one of 30 prebuilt, e.g. Kore; ElevenLabs: name or id)",
    )
    .option("--style <text>", "Delivery style (Gemini style_instructions)")
    .option(
      "--format <fmt>",
      "Output format (ElevenLabs output_format, e.g. mp3_44100_128, pcm_24000)",
    )
    .option("--language <code>", "Language code (ElevenLabs language_code, e.g. en, vi)")
    .option("--text-field <name>", "Untyped models only: input field for the text (default text)")
    .option(
      "--input <json>",
      "Extra model fields as JSON or @file.json (e.g. Gemini speakers/turns)",
    )
    .option("--detach", "Return after fal queues the job; print a receipt instead of waiting")
    .option(
      "--receipt <path>",
      "Save the request receipt to this file (--detach saves to ~/.multix/fal/requests/ by default)",
    )
    .option("--no-download", "Skip downloading audio; print result JSON only")
    .option(
      "--output-dir <dir>",
      "Download audio here (default MULTIX_OUTPUT_DIR or ./multix-output)",
    )
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "300000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (textArg: string | undefined, opts: TtsOpts) => {
      // stdout carries only the result (receipt, JSON or saved paths); progress goes to stderr.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      if (textArg !== undefined && opts.textFile !== undefined) {
        throw new ValidationError("Pass the text as an argument or with --text-file, not both");
      }
      const text = opts.textFile !== undefined ? readTextFile(opts.textFile) : textArg;
      const model = (opts.model ?? FAL_DEFAULTS.ttsModel).trim();
      appIdFromModel(model);
      const extra = opts.input === undefined ? undefined : parseInputArg(opts.input);
      const { input, profile, expectedOutput } = buildTtsInput(model, {
        text,
        voice: opts.voice,
        style: opts.style,
        format: opts.format,
        language: opts.language,
        textField: opts.textField,
        extra,
      });
      if (!profile) {
        logger.warn(
          `${model} has no typed profile in multix: its fields are not checked before submit (schema: https://fal.ai/models/${model}/api)`,
        );
      }

      const client = createFalClient();
      logger.info(`Submitting to ${model}...`);
      let receipt: FalReceipt | undefined;
      const onAccepted = (accepted: FalSubmitResponse) => {
        logger.info(`fal accepted request ${accepted.request_id}`);
        receipt = buildReceipt({
          model,
          requestId: accepted.request_id,
          status: accepted.status,
          input,
        });
        if (opts.detach || opts.receipt) receipt = persistReceipt(receipt, opts.receipt, logger);
      };
      const submit = await submitFalRequest(client, model, input, logger, onAccepted);

      if (opts.detach && receipt) {
        logger.success(`Queued fal request ${submit.request_id}`);
        logger.info(`Check: ${receipt.status_command}`);
        logger.info(`Fetch: ${receipt.result_command}`);
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }

      const result = await waitForFalResult({
        client,
        model,
        submit,
        logger,
        waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 300_000,
      });

      if (opts.download === false) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const refs = extractMediaRefs(result);
      if (refs.length === 0) {
        throw new ProviderError(
          `fal request ${submit.request_id} completed without an audio URL. Inspect it with: multix fal result ${model} ${submit.request_id}`,
          "fal",
        );
      }
      const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
      const problems: string[] = [];
      const saved = await downloadResultMedia(refs, outDir, submit.request_id, logger, {
        expect: "audio",
        problems,
      });
      if (saved.length === 0) {
        throw new ProviderError(
          `fal request ${submit.request_id} returned no usable audio (${problems.join("; ")}). Retry the download with: multix fal result ${model} ${submit.request_id} --download`,
          "fal",
        );
      }
      if (expectedOutput && !saved.some((f) => matchesOutput(f, expectedOutput))) {
        logger.warn(
          `Expected ${expectedOutput} audio from ${model}; saved ${saved.map((f) => path.extname(f)).join(", ")}`,
        );
      }
      console.log(`\nSaved ${saved.length} audio file(s):`);
      for (const f of saved) console.log(`  ${f}`);
    });
}

/** Containers that carry the expected codec (Opus usually arrives in Ogg). */
function matchesOutput(file: string, expected: string): boolean {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ext === expected || (expected === "opus" && ext === "ogg");
}
