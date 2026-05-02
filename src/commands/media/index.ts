/**
 * Registers the `media` command group: optimize, split, batch.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../core/logger.js";
import { ValidationError } from "../../core/errors.js";
import { extToKind } from "./detect-type.js";
import { optimizeVideo } from "./optimize-video.js";
import { optimizeAudio } from "./optimize-audio.js";
import { optimizeImage } from "./optimize-image.js";
import { splitVideo } from "./split-video.js";
import { batchOptimize } from "./batch.js";

export function registerMediaCommands(program: Command): void {
  const media = program
    .command("media")
    .description("Media optimization: compress video/audio/images, split long videos, batch process");

  // ── optimize ──────────────────────────────────────────────────────────────
  media
    .command("optimize")
    .description("Optimize a single media file (video, audio, or image)")
    .requiredOption("--input <file>", "Input media file")
    .requiredOption("--output <file>", "Output file path")
    .option("--target-size <MB>", "Target file size in MB")
    .option("--quality <n>", "Quality: video CRF (0-51) or image (1-100)", "85")
    .option("--max-width <px>", "Max image/video width in pixels", "1920")
    .option("--bitrate <rate>", "Audio bitrate (e.g. 64k)", "64k")
    .option("--resolution <WxH>", "Force video resolution (e.g. 1920x1080)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: {
      input: string;
      output: string;
      targetSize?: string;
      quality: string;
      maxWidth: string;
      bitrate: string;
      resolution?: string;
      verbose?: boolean;
    }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      if (!fs.existsSync(opts.input)) throw new ValidationError(`Input not found: ${opts.input}`);
      fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });

      const ext = path.extname(opts.input).toLowerCase();
      const kind = extToKind(ext);
      if (!kind) throw new ValidationError(`Unsupported file type: ${ext}`);

      const quality = Number.parseInt(opts.quality, 10);
      const maxWidth = Number.parseInt(opts.maxWidth, 10);
      const targetSizeMb = opts.targetSize ? Number.parseInt(opts.targetSize, 10) : undefined;

      if (kind === "video") {
        await optimizeVideo({ input: opts.input, output: opts.output, targetSizeMb, quality, maxWidth, resolution: opts.resolution, verbose: opts.verbose, logger });
      } else if (kind === "audio") {
        await optimizeAudio({ input: opts.input, output: opts.output, bitrate: opts.bitrate, verbose: opts.verbose, logger });
      } else {
        await optimizeImage({ input: opts.input, output: opts.output, maxWidth, quality, verbose: opts.verbose, logger });
      }
    });

  // ── split ─────────────────────────────────────────────────────────────────
  media
    .command("split")
    .description("Split a long video into fixed-duration chunks")
    .requiredOption("--input <file>", "Input video file")
    .option("--output-dir <dir>", "Output directory for chunks", "./chunks")
    .option("--chunk-duration <sec>", "Chunk duration in seconds", "3600")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: {
      input: string;
      outputDir: string;
      chunkDuration: string;
      verbose?: boolean;
    }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      if (!fs.existsSync(opts.input)) throw new ValidationError(`Input not found: ${opts.input}`);

      const chunks = await splitVideo({
        input: opts.input,
        outputDir: opts.outputDir,
        chunkDuration: Number.parseInt(opts.chunkDuration, 10),
        verbose: opts.verbose,
        logger,
      });

      console.log(`\nCreated ${chunks.length} chunk(s) in ${opts.outputDir}`);
      for (const c of chunks) console.log(`  ${c}`);
    });

  // ── batch ─────────────────────────────────────────────────────────────────
  media
    .command("batch")
    .description("Batch optimize all media files in a directory")
    .requiredOption("--input-dir <dir>", "Input directory")
    .requiredOption("--output-dir <dir>", "Output directory")
    .option("--quality <n>", "Quality setting", "85")
    .option("--max-width <px>", "Max image/video width", "1920")
    .option("--bitrate <rate>", "Audio bitrate", "64k")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: {
      inputDir: string;
      outputDir: string;
      quality: string;
      maxWidth: string;
      bitrate: string;
      verbose?: boolean;
    }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      if (!fs.existsSync(opts.inputDir)) throw new ValidationError(`Input dir not found: ${opts.inputDir}`);

      const result = await batchOptimize({
        inputDir: opts.inputDir,
        outputDir: opts.outputDir,
        quality: Number.parseInt(opts.quality, 10),
        maxWidth: Number.parseInt(opts.maxWidth, 10),
        bitrate: opts.bitrate,
        verbose: opts.verbose,
        logger,
      });

      console.log(`\nProcessed: ${result.succeeded}/${result.total} files`);
      if (result.failed > 0) {
        console.log(`Failed: ${result.failed}`);
        process.exit(1);
      }
    });
}
