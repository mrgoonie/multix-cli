/**
 * multix gemini generate-music — songs and clips with Google Lyria over the
 * Interactions API (lyria-3-clip-preview: 30 s MP3; lyria-3.5: a couple of
 * minutes, MP3 or WAV). Lyrics and an optional set of reference images go with
 * the prompt; the lyrics or song structure the model returns are saved next to
 * the audio as `<name>.txt`.
 *
 * A generation is billed per song and is never re-sent on an ambiguous
 * failure. `--interaction-id` re-reads a stored interaction (no new charge)
 * and saves its audio again.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { nameJob, run } from "../../../agent/run-state.js";
import { type AudioKind, sniffAudioKind } from "../../../core/audio-kind.js";
import { HttpError, ProviderError, ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { createInteraction } from "../client.js";
import { withGeminiKey } from "../key-pool.js";
import { INLINE_MAX_BYTES } from "../local-files.js";
import {
  MUSIC_IMAGE_MIME_TYPES,
  type MusicImage,
  type MusicInteractionResult,
  type MusicOutputFormat,
  buildMusicInteractionBody,
  parseMusicInteraction,
  validateMusicRequest,
} from "../lyria.js";
import { LYRIA_MUSIC_MODELS, getDefaultModel } from "../models.js";
import { copyToOutput, findInteractionKey, interactionMaxBytes } from "../omni-flow.js";

/** A multi-minute song is generated before the response starts; allow for it. */
const DEFAULT_TIMEOUT_SECONDS = 600;
/** Once the body starts, give up when it stalls this long. */
const IDLE_TIMEOUT_MS = 60_000;
const MAX_LYRICS_FILE_BYTES = 64 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

interface MusicOpts {
  prompt?: string;
  model?: string;
  lyrics?: string;
  lyricsFile?: string;
  image: string[];
  outputFormat?: string;
  output?: string;
  interactionId?: string;
  timeout: string;
  verbose?: boolean;
}

export function registerGeminiGenerateMusicCommand(parent: Command): void {
  parent
    .command("generate-music")
    .description("Generate music with Google Lyria (lyria-3-clip-preview, lyria-3.5)")
    .option("--prompt <str>", "Music description: genre, mood, instruments, structure")
    .option("--model <id>", `Music model (${LYRIA_MUSIC_MODELS.map((m) => m.id).join("|")})`)
    .option("--lyrics <str>", "Lyrics to sing, with optional [Verse]/[Chorus] section tags")
    .option("--lyrics-file <path>", "Read the lyrics from a UTF-8 text file")
    .option(
      "--image <path>",
      "Reference image (JPEG, PNG or WebP; repeatable, max 10)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--output-format <fmt>", "mp3 (default) or wav (lyria-3.5 only)")
    .option("--output <path>", "Copy output audio to this path")
    .option(
      "--interaction-id <id>",
      "Save the audio of an earlier stored interaction instead of generating (no new charge)",
    )
    .option(
      "--timeout <seconds>",
      "Seconds to wait for the song; it is never re-sent",
      String(DEFAULT_TIMEOUT_SECONDS),
    )
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: MusicOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const timeoutMs = parseTimeout(opts.timeout);
      const format = parseFormat(opts.outputFormat);

      let result: MusicInteractionResult;
      if (opts.interactionId) {
        if (opts.prompt || opts.lyrics || opts.lyricsFile || opts.image.length > 0) {
          throw new ValidationError(
            "--interaction-id re-reads a stored song; drop --prompt, --lyrics, --lyrics-file and --image",
          );
        }
        nameJob(opts.interactionId);
        const found = await findInteractionKey(opts.interactionId, logger, { timeoutMs });
        result = parseMusicInteraction(found.interaction);
      } else {
        if (!opts.prompt) throw new ValidationError("--prompt is required");
        if (opts.lyrics !== undefined && opts.lyricsFile) {
          throw new ValidationError("Use --lyrics or --lyrics-file, not both");
        }
        const request = {
          model: opts.model ?? getDefaultModel("generate-music"),
          prompt: opts.prompt,
          lyrics: opts.lyricsFile ? readLyricsFile(opts.lyricsFile) : opts.lyrics,
          images: [] as MusicImage[],
          outputFormat: format,
        };
        // Model, format and image count are checked before any image is read.
        validateMusicRequest({ ...request, images: [] });
        request.images = readImages(opts.image);
        result = await generateMusic(buildMusicInteractionBody(request), timeoutMs, logger);
      }

      const saved = saveMusic(result, format, opts.output, logger);
      console.log(`\nGenerated music: ${saved.audio}`);
      if (saved.text) console.log(`Lyrics/structure: ${saved.text}`);
      if (result.id) console.log(`Interaction: ${result.id}`);
    });
}

async function generateMusic(
  body: Record<string, unknown>,
  timeoutMs: number,
  logger: Logger,
): Promise<MusicInteractionResult> {
  logger.debug(`Lyria model=${String(body.model)}`);
  logger.info(`Generating music with ${String(body.model)}...`);
  let resp: unknown;
  try {
    // Key rotation only retries a 429, which is never billed.
    resp = await withGeminiKey(
      (apiKey) =>
        createInteraction(body, {
          apiKey,
          logger,
          timeoutMs,
          responseTimeoutMs: timeoutMs,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          maxBytes: interactionMaxBytes(),
        }),
      { logger },
    );
  } catch (error) {
    throw submitError(error);
  }
  const result = parseMusicInteraction(resp);
  // Billed once per finished song, which the receipt prices from this count.
  run.postUsage.push({
    tokens: {},
    metrics: { "request.count": 1 },
    ids: result.id ? [result.id] : [],
  });
  return result;
}

/** A request cut off before its response may still have produced (and billed) a song. */
function submitError(error: unknown): unknown {
  if (!(error instanceof HttpError) || error.status !== 0) return error;
  return new ProviderError(
    `Lyria request failed before a response arrived (${error.message}). It was not retried, because the song may already be generated and billed; check https://aistudio.google.com before generating again.`,
    "gemini",
    { cause: error },
  );
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new ValidationError("--timeout must be a number of seconds between 1 and 3600");
  }
  return Math.round(seconds * 1000);
}

function parseFormat(value: string | undefined): MusicOutputFormat | undefined {
  if (value === undefined) return undefined;
  const format = value.trim().toLowerCase();
  if (format !== "mp3" && format !== "wav") {
    throw new ValidationError("--output-format must be mp3 or wav");
  }
  return format;
}

function readLyricsFile(file: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ValidationError(`--lyrics-file not found: ${file}`);
  }
  if (!stat.isFile()) throw new ValidationError(`--lyrics-file is not a file: ${file}`);
  if (stat.size > MAX_LYRICS_FILE_BYTES) {
    throw new ValidationError(`--lyrics-file is larger than ${MAX_LYRICS_FILE_BYTES / 1024} KB`);
  }
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
}

/** Read local reference images as base64; their total stays under the inline request limit. */
function readImages(files: string[]): MusicImage[] {
  let total = 0;
  return files.map((file) => {
    const mimeType = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
    if (!mimeType || !MUSIC_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new ValidationError(`--image must be a JPEG, PNG or WebP file: ${file}`);
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw new ValidationError(`--image not found: ${file}`);
    }
    total += bytes.length;
    if (total > INLINE_MAX_BYTES) {
      throw new ValidationError(
        `--image files exceed ${INLINE_MAX_BYTES / 1024 / 1024} MB in total; use smaller images`,
      );
    }
    return { mimeType, data: bytes.toString("base64") };
  });
}

const EXT_BY_MIME: Record<string, AudioKind> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/**
 * Save the audio under the extension its bytes have, and the lyrics or song
 * structure next to it. Returns the saved paths.
 */
export function saveMusic(
  result: MusicInteractionResult,
  requested: MusicOutputFormat | undefined,
  output: string | undefined,
  logger: Logger,
): { audio: string; text?: string } {
  const bytes = Buffer.from(result.audio, "base64");
  const mimeKind = EXT_BY_MIME[result.mimeType.split(";")[0]?.trim().toLowerCase() ?? ""];
  const kind = sniffAudioKind(bytes) ?? mimeKind;
  if (bytes.length === 0 || !kind) {
    throw new ProviderError(
      `Lyria returned audio that is not a recognised file (${result.mimeType}, ${bytes.length} bytes)`,
      "gemini",
    );
  }
  if (requested && kind !== requested) {
    logger.warn(`Asked for ${requested} but Lyria returned ${kind}; saving it as .${kind}`);
  }

  const base = path.join(getOutputDir(), `gemini_music_${outputStamp()}`);
  const dest = `${base}.${kind}`;
  fs.writeFileSync(dest, bytes);
  logger.success(`Saved: ${dest} (${(bytes.length / 1024).toFixed(1)} KB)`);

  let textPath: string | undefined;
  if (result.text) {
    textPath = `${base}.txt`;
    fs.writeFileSync(textPath, `${result.text}\n`);
  }

  if (output) {
    const outKind = path.extname(output).slice(1).toLowerCase();
    if (outKind && outKind !== kind) {
      logger.warn(`--output ends in .${outKind} but the audio is ${kind}`);
    }
    copyToOutput(dest, output, logger);
  }
  return { audio: dest, ...(textPath ? { text: textPath } : {}) };
}
