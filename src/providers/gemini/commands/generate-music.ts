/**
 * multix gemini generate-music — music with Google Lyria over the Interactions API.
 *
 * `lyria-3-clip-preview` (default) returns a 30-second MP3 clip; `lyria-3.5`
 * a full song (MP3, or WAV with --output-format wav). Lyrics, from --lyrics or
 * --lyrics-file, are added to the prompt text; up to 10 --image references
 * steer the mood. One request, billed per song, never re-sent on a timeout.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { generateGeminiMusic } from "../generators/music.js";
import {
  LYRIA_MAX_IMAGES,
  LYRIA_MODELS,
  MUSIC_OUTPUT_FORMATS,
  type MusicOutputFormat,
} from "../lyria.js";
import { getDefaultModel } from "../models.js";

/** Lyrics files are read whole; this bounds a mistaken path to something huge. */
const MAX_LYRICS_FILE_BYTES = 64 * 1024;

interface GenerateMusicFlags {
  prompt?: string;
  model?: string;
  lyrics?: string;
  lyricsFile?: string;
  image: string[];
  outputFormat: string;
  output?: string;
  verbose?: boolean;
}

export function readLyricsFile(file: string): string {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ValidationError(`--lyrics-file not found: ${file}`);
  if (stat.size > MAX_LYRICS_FILE_BYTES) {
    throw new ValidationError(`--lyrics-file is larger than 64 KB: ${file}`);
  }
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw new ValidationError(`--lyrics-file is not a text file: ${file}`);
  return buf.toString("utf8").replace(/^﻿/, "");
}

export function registerGeminiGenerateMusicCommand(parent: Command): void {
  parent
    .command("generate-music")
    .description("Generate music with Google Lyria (30 s clip or full song)")
    .option("--prompt <str>", "Music description: genre, mood, instruments, structure, timing")
    .option("--model <id>", `Lyria model (${Object.keys(LYRIA_MODELS).join("|")})`)
    .option("--lyrics <str>", "Lyrics, with optional [Verse]/[Chorus] section tags")
    .option("--lyrics-file <path>", "Read the lyrics from a text file")
    .option(
      "--image <path>",
      `Reference image that steers the mood (repeatable, max ${LYRIA_MAX_IMAGES})`,
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option(
      "--output-format <fmt>",
      `Audio format (${MUSIC_OUTPUT_FORMATS.join("|")}; wav needs lyria-3.5)`,
      "mp3",
    )
    .option("--output <path>", "Copy output audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: GenerateMusicFlags) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      if (!opts.prompt?.trim()) throw new ValidationError("--prompt is required");
      if (opts.lyrics !== undefined && opts.lyricsFile !== undefined) {
        throw new ValidationError("Pass the lyrics once: --lyrics or --lyrics-file");
      }
      if (!MUSIC_OUTPUT_FORMATS.includes(opts.outputFormat as MusicOutputFormat)) {
        throw new ValidationError(
          `--output-format must be one of: ${MUSIC_OUTPUT_FORMATS.join(", ")}`,
        );
      }
      const lyrics = opts.lyricsFile !== undefined ? readLyricsFile(opts.lyricsFile) : opts.lyrics;

      const result = await generateGeminiMusic({
        model: opts.model ?? getDefaultModel("generate-music"),
        prompt: opts.prompt,
        lyrics,
        imagePaths: opts.image,
        outputFormat: opts.outputFormat as MusicOutputFormat,
        output: opts.output,
        logger,
      });

      console.log(`\nGenerated music: ${result.generatedAudio}`);
      if (result.lyricsFile) console.log(`Lyrics/structure: ${result.lyricsFile}`);
      if (result.interactionId) console.log(`Interaction: ${result.interactionId}`);
    });
}
