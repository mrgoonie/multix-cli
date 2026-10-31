/**
 * Gemini Lyria music generation (Node side): reads images and lyrics files,
 * sends one Interactions request and saves the song under the extension its
 * bytes really have. The request is never re-sent on an ambiguous failure
 * (timeout, dropped connection): Google may already have billed the song.
 * Only a rate-limit answer (nothing generated) rotates to the next key.
 */

import fs from "node:fs";
import path from "node:path";
import { run } from "../../../agent/run-state.js";
import { sniffAudioKind } from "../../../core/audio-kind.js";
import { HttpError, MultixError, ProviderError, ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { NOT_SENT_CODES, UNKNOWN_REMOTE_STATE, errorCodes } from "../../../core/response-read.js";
import { createInteraction } from "../client.js";
import { withGeminiKey } from "../key-pool.js";
import { INLINE_MAX_BYTES } from "../local-files.js";
import {
  LYRIA_MAX_IMAGES,
  type LyriaImage,
  type LyriaResult,
  type MusicOutputFormat,
  buildLyriaInteractionBody,
  parseLyriaInteraction,
} from "../lyria.js";
import { getMimeType } from "../task-resolver.js";

/** A full song can take minutes to compose; the request is sent once, so allow for it. */
export const MUSIC_TIMEOUT_MS = 600_000;
/** Largest response accepted: a WAV song of several minutes, base64-encoded. */
const MUSIC_MAX_RESPONSE_BYTES = 300 * 1024 * 1024;

export interface GeminiMusicOpts {
  model: string;
  prompt: string;
  lyrics?: string;
  imagePaths?: string[];
  outputFormat: MusicOutputFormat;
  output?: string;
  logger?: Logger;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface GeminiMusicResult {
  generatedAudio: string;
  /** Copy written to --output, when given. */
  output?: string;
  /** Lyrics or song structure the model returned, saved next to the audio. */
  lyricsFile?: string;
  model: string;
  mimeType: string;
  interactionId?: string;
}

/** Read local images as base64 parts; each must be an image under the inline size limit. */
export function readLyriaImages(paths: string[]): LyriaImage[] {
  return paths.map((p) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      throw new ValidationError(`Image not found: ${p}`);
    }
    if (!stat.isFile()) throw new ValidationError(`Not a file: ${p}`);
    if (stat.size > INLINE_MAX_BYTES) {
      throw new ValidationError(`Image is larger than ${INLINE_MAX_BYTES / 1024 / 1024} MB: ${p}`);
    }
    const mimeType = getMimeType(p);
    if (!mimeType.startsWith("image/")) throw new ValidationError(`Not an image file: ${p}`);
    return { mimeType, data: fs.readFileSync(p).toString("base64") };
  });
}

/**
 * A failure after the request may have reached Google: a dropped connection
 * or timeout (unless the connection was never made), or a gateway error after
 * a long generation. The song may exist and be billed, so it is not retryable.
 */
function isAmbiguousFailure(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status === 0) return !errorCodes(e).some((c) => NOT_SENT_CODES.has(c));
  return e.status === 502 || e.status === 503 || e.status === 504;
}

export async function generateGeminiMusic(opts: GeminiMusicOpts): Promise<GeminiMusicResult> {
  const { model, outputFormat, logger } = opts;
  if ((opts.imagePaths?.length ?? 0) > LYRIA_MAX_IMAGES) {
    throw new ValidationError(
      `Lyria takes at most ${LYRIA_MAX_IMAGES} images (got ${opts.imagePaths?.length})`,
    );
  }
  const body = buildLyriaInteractionBody({
    model,
    prompt: opts.prompt,
    lyrics: opts.lyrics,
    images: readLyriaImages(opts.imagePaths ?? []),
    outputFormat,
  });
  logger?.debug(
    `Lyria model=${model} format=${outputFormat} images=${opts.imagePaths?.length ?? 0} lyrics=${opts.lyrics !== undefined}`,
  );

  let resp: unknown;
  try {
    resp = await withGeminiKey(
      (apiKey) =>
        createInteraction(body, {
          apiKey,
          logger,
          timeoutMs: MUSIC_TIMEOUT_MS,
          maxBytes: MUSIC_MAX_RESPONSE_BYTES,
          fetch: opts.fetch,
        }),
      { logger },
    );
  } catch (e) {
    if (isAmbiguousFailure(e)) {
      throw new MultixError(
        `${(e as Error).message}. The music request was not re-sent: Google may still have generated and billed it. Check before running it again, or you may pay twice.`,
        UNKNOWN_REMOTE_STATE,
        { cause: e },
      );
    }
    throw e;
  }
  // Billed per song once the interaction answers; recorded before parsing so a
  // refused or empty answer still shows up on the receipt as a spent request.
  run.postUsage.push({ tokens: {}, metrics: { "request.count": 1 }, ids: [] });

  const result = parseLyriaInteraction(resp);
  return saveMusic(result, opts);
}

function saveMusic(result: LyriaResult, opts: GeminiMusicOpts): GeminiMusicResult {
  const { logger, outputFormat } = opts;
  const bytes = Buffer.from(result.audio.data, "base64");
  if (bytes.length === 0) throw new ProviderError("Lyria returned empty audio", "gemini");
  const kind = sniffAudioKind(bytes);
  if (kind !== "mp3" && kind !== "wav") {
    throw new ProviderError(
      `Lyria returned audio that is neither MP3 nor WAV (mime ${result.audio.mimeType})`,
      "gemini",
    );
  }
  if (kind !== outputFormat) {
    logger?.warn(`Asked for ${outputFormat} but Lyria returned ${kind}; saved as ${kind}.`);
  }

  const stamp = outputStamp();
  const outDir = getOutputDir();
  const dest = path.join(outDir, `gemini_music_${stamp}.${kind}`);
  fs.writeFileSync(dest, bytes);
  logger?.success(`Saved: ${dest} (${(bytes.length / 1024).toFixed(1)} KB)`);

  let lyricsFile: string | undefined;
  if (result.text) {
    lyricsFile = path.join(outDir, `gemini_music_${stamp}.txt`);
    fs.writeFileSync(lyricsFile, `${result.text}\n`);
    logger?.success(`Lyrics/structure: ${lyricsFile}`);
  }

  let output: string | undefined;
  if (opts.output) {
    const ext = path.extname(opts.output).slice(1).toLowerCase();
    if (ext && ext !== kind) {
      logger?.warn(`--output ends in .${ext} but the audio is ${kind}`);
    }
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(dest, opts.output);
    output = opts.output;
    logger?.success(`Copied to: ${opts.output}`);
  }

  return {
    generatedAudio: dest,
    ...(output ? { output } : {}),
    ...(lyricsFile ? { lyricsFile } : {}),
    model: opts.model,
    mimeType: result.audio.mimeType,
    ...(result.id ? { interactionId: result.id } : {}),
  };
}
