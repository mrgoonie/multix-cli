/**
 * multix fish clone — a persistent voice from audio samples (POST /model,
 * multipart, type=tts, train_mode=fast). Private unless --visibility unlist.
 * Requires --consent: cloning a voice needs its owner's permission. Sent
 * once, never retried (a retry could create a second voice).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { requireFishKey } from "../client.js";
import {
  type CloneSample,
  FISH_VISIBILITIES,
  MAX_CLONE_SAMPLES,
  createFishClone,
} from "../voices-client.js";

/** Per-sample and whole-upload caps; Fish recommends a minute or two of speech. */
const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const SAMPLE_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".opus", ".ogg", ".flac"]);
const MAX_TRANSCRIPT_FILE_BYTES = 1024 * 1024;

function readTranscripts(file: string): string[] {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`--transcript-file not found: ${file}`);
  }
  if (fs.statSync(resolved).size > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new ValidationError(
      `--transcript-file is larger than ${MAX_TRANSCRIPT_FILE_BYTES} bytes`,
    );
  }
  return fs
    .readFileSync(resolved, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const collect = (value: string, previous: string[]) => [...previous, value];

async function sampleFile(file: string, text: string | undefined): Promise<CloneSample> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`--sample file not found: ${file}`);
  }
  const size = fs.statSync(resolved).size;
  if (size === 0 || size > MAX_SAMPLE_BYTES) {
    throw new ValidationError(`--sample ${file} must be 1 byte to ${MAX_SAMPLE_BYTES} bytes`);
  }
  if (!SAMPLE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new ValidationError(
      `--sample ${file}: Fish takes ${[...SAMPLE_EXTENSIONS].join(", ")} audio`,
    );
  }
  const name = path.basename(resolved);
  return {
    name,
    // Read from disk while uploading instead of holding every sample in memory.
    data: await fs.openAsBlob(resolved),
    ...(text !== undefined ? { text } : {}),
  };
}

export function registerFishCloneCommand(parent: Command): void {
  parent
    .command("clone")
    .description("Create a reusable Fish Audio voice from audio samples (private by default)")
    .requiredOption("--title <name>", "Name of the new voice")
    .option(
      "--sample <path>",
      `Audio sample (wav, mp3, m4a, opus); repeat for up to ${MAX_CLONE_SAMPLES}`,
      collect,
      [],
    )
    .option(
      "--transcript <text>",
      "Words spoken in the sample at the same position; repeat once per sample (else Fish transcribes)",
      collect,
      [],
    )
    .option(
      "--transcript-file <path>",
      "UTF-8 file with one transcript per line, one line per sample",
    )
    .option("--description <text>", "Voice description")
    .option("--tag <tag>", "Tag (repeatable)", collect, [])
    .option(
      "--visibility <v>",
      `${FISH_VISIBILITIES.join("|")} (public is published from Fish's web app)`,
      "private",
    )
    .option("--no-enhance", "Skip Fish's noise removal and level normalization")
    .option(
      "--design-signature <sig>",
      "Signature of a `fish voice-design` candidate, one per sample in order",
      collect,
      [],
    )
    .option("--consent", "Confirm you have the speaker's permission to clone this voice")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      if (!opts.consent) {
        throw new ValidationError(
          "Cloning a voice needs its owner's permission: re-run with --consent to confirm you have it",
        );
      }
      if (!(FISH_VISIBILITIES as readonly string[]).includes(opts.visibility)) {
        throw new ValidationError(`--visibility must be one of ${FISH_VISIBILITIES.join(", ")}`);
      }
      const files: string[] = opts.sample;
      if (files.length === 0) throw new ValidationError("Give at least one --sample <audio file>");
      if (opts.transcript.length > 0 && opts.transcriptFile) {
        throw new ValidationError("Use --transcript or --transcript-file, not both");
      }
      const transcripts: string[] = opts.transcriptFile
        ? readTranscripts(opts.transcriptFile)
        : opts.transcript;
      if (transcripts.length > 0 && transcripts.length !== files.length) {
        throw new ValidationError(
          `Give one transcript per sample (${files.length} samples, ${transcripts.length} transcripts)`,
        );
      }
      const samples = await Promise.all(files.map((f, i) => sampleFile(f, transcripts[i])));
      const total = samples.reduce((n, s) => n + s.data.size, 0);
      if (total > MAX_UPLOAD_BYTES) {
        throw new ValidationError(
          `The samples add up to ${total} bytes; at most ${MAX_UPLOAD_BYTES} bytes go in one clone`,
        );
      }
      run.data = {
        provider: "fish",
        title: opts.title,
        samples: samples.map((s) => ({ name: s.name, bytes: s.data.size })),
        transcripts: transcripts.length,
        visibility: opts.visibility,
        dry_run: run.dryRun,
      };
      const apiKey = requireFishKey();
      logger.debug(`Cloning ${samples.length} sample(s)`);
      const voice = await createFishClone({
        apiKey,
        title: opts.title,
        samples,
        description: opts.description,
        visibility: opts.visibility,
        tags: opts.tag,
        enhanceAudioQuality: opts.enhance,
        ...(opts.designSignature.length > 0 ? { designSignatures: opts.designSignature } : {}),
      });
      run.data = voice;
      if (run.json) {
        console.log(JSON.stringify(voice));
        return;
      }
      logger.success(`Created voice ${voice.id} (${voice.state ?? "unknown state"})`);
      console.log(`\nSpeak with it: multix fish tts --voice ${voice.id} --text "..."`);
    });
}
