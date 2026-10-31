/**
 * Node-only Gemini Lyria music flow for the CLI: read local inputs, submit
 * once, persist the interaction id, poll, and save the audio.
 *
 * Billing safety (the same rules as the Omni video flow in omni-flow.ts):
 * - Only the submit may rotate keys, and only on a quota response (nothing was
 *   accepted). A network failure, timeout or 5xx on the submit is never
 *   retried: the song may already be generating and billed.
 * - Once accepted, polling stays on the key that created the interaction.
 * - The interaction id is written to a session record before polling starts,
 *   so a timeout or crash is resumed with `gemini music-status`, never by
 *   paying for a second song.
 */

import fs from "node:fs";
import path from "node:path";
import { run, trackInFlight } from "../../agent/run-state.js";
import { PollTimeoutError } from "../../core/async-poll.js";
import {
  HttpError,
  ProviderError,
  ProviderJobFailedError,
  ValidationError,
} from "../../core/errors.js";
import { maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { outputStamp } from "../../core/output-name.js";
import { createInteraction } from "./client.js";
import { withGeminiKey } from "./key-pool.js";
import { INLINE_MAX_BYTES } from "./local-files.js";
import {
  LYRIA_IMAGE_MIME_TYPES,
  type LyriaFormat,
  type LyriaRequestOptions,
  buildLyriaRequest,
  extractLyriaAudio,
  extractLyriaText,
  lyriaCost,
  lyriaFailureMessage,
  sniffAudioFormat,
  validateLyriaRequest,
} from "./lyria.js";
import { type GeminiKeyChoice, copyToOutput, waitForInteraction } from "./omni-flow.js";
import { type Interaction, base64DecodedBytes, isTerminalInteraction } from "./omni.js";
import { getMimeType } from "./task-resolver.js";

const SUBMIT_TIMEOUT_MS = 120_000;
export const LYRIA_DEFAULT_WAIT_MS = 10 * 60 * 1000;
/** Largest lyrics file read (plain text; songs are far shorter). */
const MAX_LYRICS_FILE_BYTES = 64 * 1024;

export function musicResumeCommand(id: string): string {
  return `multix gemini music-status ${id} --download`;
}

export interface LyriaRunOptions {
  request: Omit<LyriaRequestOptions, "images">;
  imagePaths?: string[];
  /** Poll until done and save the audio (default). false: submit and print the id. */
  wait: boolean;
  waitTimeoutMs: number;
  output?: string;
  logger: Logger;
}

/** Portable session record written next to the audio (never holds a key or audio bytes). */
export interface LyriaSessionRecord {
  provider: "gemini";
  interaction_id: string;
  model: string;
  /** Env var of the key that owns the interaction (never its value). */
  key_alias: string;
  status: string;
  created_at: string;
  updated_at: string;
  request: Record<string, unknown>;
  output_path?: string;
  lyrics_path?: string;
  usage?: unknown;
  cost_estimate?: unknown;
  error?: string;
}

/** Read `--lyrics-file` (UTF-8, BOM stripped), bounded. */
export function readLyricsFile(p: string): string {
  const stat = fs.statSync(p, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ValidationError(`Lyrics file not found: ${p}`);
  if (stat.size > MAX_LYRICS_FILE_BYTES) {
    throw new ValidationError(`Lyrics file is over ${MAX_LYRICS_FILE_BYTES / 1024} KB: ${p}`);
  }
  const text = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
  if (!text.trim()) throw new ValidationError(`Lyrics file is empty: ${p}`);
  return text;
}

/** Validate local images before any request; returns their inline parts. */
export function readLyriaImages(paths: string[]): Array<{ data: string; mime_type: string }> {
  let total = 0;
  return paths.map((p) => {
    if (/^https?:\/\//i.test(p)) {
      throw new ValidationError(`Image must be a local file, not a URL: ${p}`);
    }
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ValidationError(`Image not found: ${p}`);
    const mime = getMimeType(p);
    if (!LYRIA_IMAGE_MIME_TYPES.has(mime)) {
      throw new ValidationError(
        `Lyria accepts PNG, JPEG, WebP or HEIC/HEIF images: ${p} (${mime})`,
      );
    }
    total += stat.size;
    if (total > INLINE_MAX_BYTES) {
      throw new ValidationError(
        `Reference images add up to more than ${INLINE_MAX_BYTES / (1024 * 1024)} MB; send fewer or smaller images`,
      );
    }
    return { data: fs.readFileSync(p).toString("base64"), mime_type: mime };
  });
}

/** Turn a submit failure into an actionable message (rotation on 429 has already run). */
function submitError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const check = "check https://aistudio.google.com before submitting again.";
  if (error.status === 0) {
    return new ProviderError(
      `Gemini Lyria submit failed before a response arrived (${error.message}). It was not retried, because the song may already be generating and billed; ${check}`,
      "gemini",
      { cause: error },
    );
  }
  const message = /"message"\s*:\s*"([^"]+)"/.exec(error.snippet)?.[1] ?? error.snippet;
  const paid = /billing|paid|tier|permission/i.test(message)
    ? " Lyria needs a billing-enabled (paid tier) Gemini API key."
    : "";
  // A 5xx may come after Google accepted the job, so it gets the same warning as a lost response.
  const maybeBilled =
    error.status >= 500 ? ` The song may already be generating and billed; ${check}` : "";
  return new ProviderError(
    `Gemini Lyria request failed (HTTP ${error.status}): ${message}${paid}${maybeBilled}`,
    "gemini",
    { cause: error },
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeRecord(file: string, record: LyriaSessionRecord): void {
  record.updated_at = nowIso();
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Request parameters worth keeping (no image bytes, only local file names). */
function requestSummary(opts: LyriaRunOptions): Record<string, unknown> {
  const r = opts.request;
  return {
    prompt: r.prompt,
    ...(r.lyrics ? { lyrics: r.lyrics } : {}),
    ...(r.format ? { output_format: r.format } : {}),
    ...(opts.imagePaths?.length ? { images: opts.imagePaths.map((p) => path.basename(p)) } : {}),
  };
}

/**
 * Generate a song or clip with Lyria. Returns the saved audio path (undefined
 * with `wait: false`), the lyrics path when the model returned text, and the
 * interaction id.
 */
export async function runLyriaMusic(opts: LyriaRunOptions): Promise<{
  interactionId: string;
  dest?: string;
  lyricsPath?: string;
  recordPath: string;
}> {
  const { logger, request } = opts;
  validateLyriaRequest({
    model: request.model,
    prompt: request.prompt,
    format: request.format,
    imageCount: opts.imagePaths?.length,
  });
  const images = readLyriaImages(opts.imagePaths ?? []);
  const body = buildLyriaRequest({ ...request, images });
  const deadline = Date.now() + opts.waitTimeoutMs;

  let accepted: GeminiKeyChoice & { resp: Interaction };
  try {
    accepted = await withGeminiKey(
      async (apiKey, keyName) => {
        const resp = (await createInteraction(body, {
          apiKey,
          timeoutMs: SUBMIT_TIMEOUT_MS,
        })) as Interaction;
        return { apiKey, keyName, resp };
      },
      { logger },
    );
  } catch (error) {
    throw submitError(error);
  }

  const { apiKey, keyName } = accepted;
  let interaction = accepted.resp;
  const interactionId = typeof interaction?.id === "string" ? interaction.id : "";
  if (!interactionId) throw new ProviderError("Gemini Lyria returned no interaction id", "gemini");

  const outDir = getOutputDir();
  const base = `gemini_lyria_${outputStamp()}`;
  const recordPath = path.join(outDir, `${base}.json`);
  const record: LyriaSessionRecord = {
    provider: "gemini",
    interaction_id: interactionId,
    model: String(body.model),
    key_alias: keyName,
    status: interaction.status ?? "in_progress",
    created_at: nowIso(),
    updated_at: nowIso(),
    request: requestSummary(opts),
  };
  // The job is accepted and billed: show its id even if the record cannot be written,
  // and a run stopped from here on offers the resume command instead of a paid rerun.
  trackInFlight(interactionId, musicResumeCommand(interactionId));
  logger.info(`Interaction ID: ${interactionId}`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    writeRecord(recordPath, record);
    logger.info(`Session record: ${recordPath}`);
  } catch (error) {
    logger.warn(`Could not write the session record ${recordPath}: ${(error as Error).message}`);
  }

  if (!opts.wait) {
    logger.info(`Resume with: ${musicResumeCommand(interactionId)}`);
    return { interactionId, recordPath };
  }

  if (!isTerminalInteraction(interaction.status)) {
    logger.info("Generating music with Gemini Lyria (usually under a minute)...");
    try {
      interaction = await waitForInteraction(
        interactionId,
        apiKey,
        Math.max(1, deadline - Date.now()),
        logger,
        undefined,
        musicResumeCommand,
      );
    } catch (error) {
      if (error instanceof PollTimeoutError) writeRecord(recordPath, record);
      throw error;
    }
  }

  record.status = interaction.status ?? "unknown";
  record.usage = interaction.usage;
  if (interaction.status !== "completed") {
    record.error = lyriaFailureMessage(interaction);
    writeRecord(recordPath, record);
    throw new ProviderJobFailedError(record.error, "gemini", {
      terminal: isTerminalInteraction(interaction.status) && interaction.status !== "cancelled",
    });
  }
  // Lyria bills once per song produced, which settles the run's receipt at the list price.
  run.postUsage.push({ tokens: {}, metrics: { "request.count": 1 }, ids: [] });
  const cost = lyriaCost(record.model);
  if (cost) record.cost_estimate = cost;

  const saved = saveLyriaAudio(interaction, path.join(outDir, base));
  record.output_path = saved.dest;
  if (saved.lyricsPath) record.lyrics_path = saved.lyricsPath;
  writeRecord(recordPath, record);
  logger.success(`Saved music: ${saved.dest}`);
  if (saved.lyricsPath) logger.info(`Lyrics and structure: ${saved.lyricsPath}`);
  copyToOutput(saved.dest, opts.output, logger);
  return { interactionId, dest: saved.dest, lyricsPath: saved.lyricsPath, recordPath };
}

/**
 * Write the song of a completed interaction to `<destBase>.<mp3|wav>` (the
 * extension follows the bytes, not the request) and any lyrics the model
 * returned to `<destBase>.lyrics.txt`. Inline base64 is size-checked before it
 * is decoded.
 */
export function saveLyriaAudio(
  interaction: Interaction,
  destBase: string,
): { dest: string; format: LyriaFormat; bytes: number; lyricsPath?: string } {
  const audio = extractLyriaAudio(interaction);
  if (!audio) {
    throw new ProviderError(
      `Gemini Lyria completed without audio. ${lyriaFailureMessage(interaction)}`,
      "gemini",
    );
  }
  const maxBytes = maxDownloadBytes();
  const size = base64DecodedBytes(audio.data);
  if (size > maxBytes) {
    throw new ProviderError(
      `Inline audio is ${size} bytes, over the ${maxBytes}-byte download limit (MULTIX_MAX_DOWNLOAD_MB)`,
      "gemini",
    );
  }
  const bytes = Buffer.from(audio.data, "base64");
  const format = sniffAudioFormat(bytes);
  if (!format) {
    throw new ProviderError(
      "Gemini Lyria returned audio that is neither MP3 nor WAV; nothing was saved",
      "gemini",
    );
  }
  const dest = `${destBase}.${format}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  const text = extractLyriaText(interaction);
  let lyricsPath: string | undefined;
  if (text) {
    lyricsPath = `${destBase}.lyrics.txt`;
    fs.writeFileSync(lyricsPath, `${text}\n`);
  }
  return { dest, format, bytes: bytes.length, lyricsPath };
}
