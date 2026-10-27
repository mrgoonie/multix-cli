/**
 * multix fal tts [text] — text-to-speech on fal.ai. Maps typed flags onto each
 * model's own input schema (speech-input.ts), then reuses the generic queue
 * flow of `fal run`: one submit (never retried), durable receipts with
 * `--detach` / `--receipt`, polling, and an audio download whose extension is
 * checked against the bytes (speech-output.ts).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { appIdFromModel, createFalClient } from "../client.js";
import { FAL_DEFAULTS } from "../models.js";
import { type FalReceipt, buildReceipt, persistReceipt } from "../request-receipt.js";
import { parseInputArg, submitFalRequest, waitForFalResult } from "../run-helpers.js";
import { type SpeechFlags, buildSpeechRequest } from "../speech-input.js";
import { FAL_SPEECH_MODELS, expectedAudioExt } from "../speech-models.js";
import { type SavedAudio, saveSpeechAudio } from "../speech-output.js";
import type { FalResultResponse, FalSubmitResponse } from "../types.js";

interface TtsFlags {
  model?: string;
  text?: string;
  textFile?: string;
  voice?: string;
  style?: string;
  format?: string;
  language?: string;
  input?: string;
  textField?: string;
  voiceField?: string;
  detach?: boolean;
  receipt?: string;
  download: boolean;
  outputDir?: string;
  waitTimeout: string;
  verbose?: boolean;
}

/** Text files are read whole; this bounds a mistaken path to something huge. */
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

function readTextFile(file: string): string {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ValidationError(`--text-file not found: ${file}`);
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new ValidationError(`--text-file is larger than 1 MB: ${file}`);
  }
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw new ValidationError(`--text-file is not a text file: ${file}`);
  // A trailing newline is file formatting, not speech.
  return buf
    .toString("utf8")
    .replace(/^﻿/, "")
    .replace(/\r?\n$/, "");
}

function textFrom(positional: string | undefined, opts: TtsFlags): string | undefined {
  const given = [positional, opts.text, opts.textFile].filter((v) => v !== undefined);
  if (given.length > 1) {
    throw new ValidationError("Pass the text once: a positional, --text or --text-file");
  }
  if (opts.textFile !== undefined) return readTextFile(opts.textFile);
  return positional ?? opts.text;
}

export interface FalTtsRun {
  detach: boolean;
  /** Save the receipt here (a detached run saves it to the default directory otherwise). */
  receiptFile?: string;
  download: boolean;
  /** Download directory; without it the default output directory, resolved only when downloading. */
  outDir?: string;
  waitTimeoutMs: number;
  logger: Logger;
}

export interface FalTtsOutcome {
  requestId: string;
  receipt?: FalReceipt;
  /** Absent for a detached run. */
  result?: FalResultResponse;
  /** The downloaded audio; absent for a detached run or without download. */
  saved?: SavedAudio;
}

/**
 * Build the per-model input, submit it once (never retried) on the fal queue,
 * then either return the receipt (detached) or wait and save the audio.
 * Shared by `fal tts` and the `multix speech` façade.
 */
export async function runFalTts(flags: SpeechFlags, opts: FalTtsRun): Promise<FalTtsOutcome> {
  const { model } = flags;
  const { logger } = opts;
  appIdFromModel(model);
  const request = buildSpeechRequest(flags);
  const client = createFalClient();

  logger.info(`Submitting to ${model}...`);
  let receipt: FalReceipt | undefined;
  const onAccepted = (accepted: FalSubmitResponse) => {
    logger.info(`fal accepted request ${accepted.request_id}`);
    receipt = buildReceipt({
      model,
      requestId: accepted.request_id,
      status: accepted.status,
      input: request.input,
      // Raw formats (pcm, ulaw, alaw) have no header; resuming must know which was asked for.
      ...(request.format ? { resultArgs: ["--format", request.format] } : {}),
    });
    if (opts.detach || opts.receiptFile) {
      receipt = persistReceipt(receipt, opts.receiptFile, logger);
    }
  };
  const submit = await submitFalRequest(client, model, request.input, logger, onAccepted);
  if (opts.detach && receipt) return { requestId: submit.request_id, receipt };

  const result = await waitForFalResult({
    client,
    model,
    submit,
    logger,
    waitTimeoutMs: opts.waitTimeoutMs,
  });
  const done = { requestId: submit.request_id, ...(receipt ? { receipt } : {}), result };
  if (!opts.download) return done;
  const saved = await saveSpeechAudio({
    result,
    outDir: opts.outDir ?? getOutputDir(),
    requestId: submit.request_id,
    // Only a requested format is a promise about the bytes; a model default may change.
    ...(request.format ? { expectedExt: expectedAudioExt(request.profile, request.format) } : {}),
    logger,
  });
  return { ...done, saved };
}

export function registerFalTtsCommand(parent: Command): void {
  parent
    .command("tts [text]")
    .description(
      "Text-to-speech on fal.ai with per-model typed inputs (list models, voices and formats: multix fal voices)",
    )
    .option(
      "-m, --model <id>",
      `TTS model (${FAL_SPEECH_MODELS.map((m) => m.id).join("|")}) (default: ${FAL_DEFAULTS.ttsModel}); other fal TTS ids need --text-field`,
    )
    .option("--text <str>", "Text to speak (or a positional, or --text-file)")
    .option("--text-file <path>", "Read the text to speak from a UTF-8 file")
    .option("--voice <name>", "Voice (checked against the model's voice list when it has one)")
    .option("--style <text>", "Delivery style instructions (Gemini TTS)")
    .option(
      "--format <fmt>",
      "Output format, e.g. mp3_44100_128, pcm_16000, opus_48000_64 (ElevenLabs)",
    )
    .option("--language <code>", "ISO 639-1 language code (ElevenLabs)")
    .option("--input <json>", "Extra model-specific input fields as JSON, or @path/to/file.json")
    .option("--text-field <name>", "Input field for the text (required for unlisted models)")
    .option("--voice-field <name>", "Input field for --voice on unlisted models")
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
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "480000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (positional: string | undefined, opts: TtsFlags) => {
      // stdout carries only the result (receipt, JSON or saved path); progress goes to stderr.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const out = await runFalTts(
        {
          model: opts.model ?? FAL_DEFAULTS.ttsModel,
          text: textFrom(positional, opts),
          voice: opts.voice,
          style: opts.style,
          format: opts.format,
          language: opts.language,
          textField: opts.textField,
          voiceField: opts.voiceField,
          ...(opts.input !== undefined ? { extra: parseInputArg(opts.input) } : {}),
        },
        {
          detach: Boolean(opts.detach),
          receiptFile: opts.receipt,
          download: opts.download !== false,
          ...(opts.outputDir ? { outDir: path.resolve(opts.outputDir) } : {}),
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 480_000,
          logger,
        },
      );
      if (out.receipt && !out.result) {
        logger.success(`Queued fal request ${out.requestId}`);
        logger.info(`Check: ${out.receipt.status_command}`);
        logger.info(`Fetch: ${out.receipt.result_command}`);
        console.log(JSON.stringify(out.receipt, null, 2));
        return;
      }
      if (!out.saved) {
        console.log(JSON.stringify(out.result, null, 2));
        return;
      }
      console.log(`\nGenerated audio: ${out.saved.path}`);
    });
}
