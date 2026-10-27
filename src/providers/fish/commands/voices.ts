/**
 * multix fish voices list|get|create|update|delete — Fish Audio voice models.
 * `list` shows your own voices by default; `--public` searches the library.
 * `create` clones a voice from local samples (needs `--consent`: only clone a
 * voice you have the right to use); `update` edits metadata; `delete` removes
 * a model and needs `--yes`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { type AudioKind, sniffAudioKind } from "../../../core/audio-kind.js";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { requireFishKey } from "../client.js";
import {
  FISH_MAX_VOICE_SAMPLES,
  FISH_VISIBILITIES,
  type FishVisibility,
  type FishVoice,
  type FishVoiceSample,
  createFishVoice,
  deleteFishVoice,
  getFishVoice,
  listFishVoices,
  updateFishVoice,
} from "../voices-client.js";

/** Sample containers Fish takes, by file extension, and the bytes each must start with. */
const SAMPLE_TYPES: Record<string, { kind: AudioKind; mime: string }> = {
  ".wav": { kind: "wav", mime: "audio/wav" },
  ".mp3": { kind: "mp3", mime: "audio/mpeg" },
  ".m4a": { kind: "m4a", mime: "audio/mp4" },
  ".opus": { kind: "ogg", mime: "audio/ogg" },
};
/** Per-sample cap, so a wrong path cannot upload a huge file. */
const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;
const TITLE_MAX = 200;

const collect = (value: string, previous: string[] = []) => [...previous, value];

function voiceId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new ValidationError(`"${id}" is not a Fish Audio voice id`);
  }
  return id;
}

/** Read and check one sample file: known extension, matching audio header, size cap. */
export function readFishSample(file: string): FishVoiceSample {
  const resolved = path.resolve(file);
  const ext = path.extname(resolved).toLowerCase();
  const named = SAMPLE_TYPES[ext];
  // A file with no extension (a downloaded signed URL) is typed by its bytes alone.
  if (!named && ext !== "") {
    throw new ValidationError(
      `--sample ${file}: Fish takes ${Object.keys(SAMPLE_TYPES).join(", ")} files`,
    );
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ValidationError(`--sample file not found: ${file}`);
  }
  const size = fs.statSync(resolved).size;
  if (size === 0 || size > MAX_SAMPLE_BYTES) {
    throw new ValidationError(`--sample ${file} must be 1 byte to ${MAX_SAMPLE_BYTES} bytes`);
  }
  const bytes = new Uint8Array(fs.readFileSync(resolved));
  const sniffed = sniffAudioKind(bytes);
  const type = named ?? Object.values(SAMPLE_TYPES).find((t) => t.kind === sniffed);
  if (!type || sniffed !== type.kind) {
    throw new ValidationError(
      named
        ? `--sample ${file} is named ${ext} but its bytes ${sniffed ? `are ${sniffed}` : "have no known audio header"}`
        : `--sample ${file} has no extension and its bytes are not wav, mp3, m4a or opus audio`,
    );
  }
  const name = named
    ? path.basename(resolved)
    : `${path.basename(resolved)}.${type.kind === "ogg" ? "opus" : type.kind}`;
  return { name, bytes, mime: type.mime };
}

function visibility(value: string | undefined): FishVisibility | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!(FISH_VISIBILITIES as readonly string[]).includes(v)) {
    throw new ValidationError(`--visibility must be one of ${FISH_VISIBILITIES.join(", ")}`);
  }
  return v as FishVisibility;
}

function title(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (t === "" || [...t].length > TITLE_MAX) {
    throw new ValidationError(`--title must be 1 to ${TITLE_MAX} characters`);
  }
  return t;
}

export interface FishVoiceCreateOptions {
  title?: string;
  sample?: string[];
  transcript?: string[];
  description?: string;
  tag?: string[];
  visibility?: string;
  enhanceAudioQuality?: boolean;
  generateSample?: boolean;
  voiceDesignSignature?: string[];
  consent?: boolean;
  verbose?: boolean;
}

/** Validate a create request and read its samples; nothing is sent. */
export function fishVoiceCreateInput(opts: FishVoiceCreateOptions) {
  if (!opts.consent) {
    throw new ValidationError(
      "Cloning a voice needs --consent: confirm you own the voice or have the speaker's permission to clone it",
    );
  }
  const name = title(opts.title);
  if (!name) throw new ValidationError("Name the voice with --title");
  const vis = visibility(opts.visibility);
  if (vis === "public") {
    throw new ValidationError(
      "--visibility public is not available when creating (Fish makes it private); publish from the Fish Audio website, or use unlist",
    );
  }
  const files = opts.sample ?? [];
  if (files.length < 1 || files.length > FISH_MAX_VOICE_SAMPLES) {
    throw new ValidationError(`Give 1 to ${FISH_MAX_VOICE_SAMPLES} --sample files`);
  }
  const texts = opts.transcript ?? [];
  if (texts.length > 0 && texts.length !== files.length) {
    throw new ValidationError(
      `Give one --transcript per --sample, in the same order (${files.length} samples, ${texts.length} transcripts), or none to let Fish transcribe`,
    );
  }
  if (texts.some((t) => t.trim() === "")) throw new ValidationError("--transcript cannot be empty");
  const signatures = opts.voiceDesignSignature ?? [];
  if (signatures.length > 0 && signatures.length !== files.length) {
    throw new ValidationError(
      "Give one --voice-design-signature per --sample, in the same order (Fish rejects a mismatch)",
    );
  }
  return {
    title: name,
    samples: files.map(readFishSample),
    ...(texts.length ? { texts } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.tag?.length ? { tags: opts.tag } : {}),
    ...(vis ? { visibility: vis } : {}),
    ...(opts.enhanceAudioQuality === false ? { enhanceAudioQuality: false } : {}),
    ...(opts.generateSample ? { generateSample: true } : {}),
    ...(signatures.length ? { voiceDesignSignatures: signatures } : {}),
  };
}

function line(v: FishVoice): string {
  const meta = [v.state, v.visibility, v.languages.join("/")].filter(Boolean).join(", ");
  return `${v.id}  ${v.title ?? "(untitled)"}${meta ? `  (${meta})` : ""}`;
}

function pageNumber(value: string, flag: string, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`${flag} must be a whole number from 1 to ${max}`);
  }
  return n;
}

export function registerFishVoicesCommand(parent: Command): void {
  const voices = parent.command("voices").description("List and read Fish Audio voice models");
  voices
    .command("list")
    .description("List your Fish Audio voice models (or public ones with --public)")
    .option("--public", "Search public voices instead of your own")
    .option("--title <text>", "Filter by title")
    .option("--language <code>", "Filter by language (en, zh, ja, vi, ...)")
    .option("--page-size <n>", "Results per page, 1 to 100", "20")
    .option("--page <n>", "Page number", "1")
    .action(
      async (opts: {
        public?: boolean;
        title?: string;
        language?: string;
        pageSize: string;
        page: string;
      }) => {
        const page = await listFishVoices({
          apiKey: requireFishKey(),
          self: !opts.public,
          pageSize: pageNumber(opts.pageSize, "--page-size", 100),
          pageNumber: pageNumber(opts.page, "--page", 10_000),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.language ? { language: opts.language } : {}),
        });
        if (run.json) {
          console.log(JSON.stringify(page));
          return;
        }
        if (page.items.length === 0) {
          console.log(opts.public ? "No public voices matched." : "No voices in your account yet.");
          return;
        }
        for (const v of page.items) console.log(line(v));
        if (page.has_more) console.log(`... more on --page ${Number(opts.page) + 1}`);
      },
    );
  voices
    .command("get <id>")
    .description("Show one Fish Audio voice model (state, visibility, languages)")
    .action(async (id: string) => {
      const voice = await getFishVoice({ apiKey: requireFishKey(), id: voiceId(id) });
      console.log(run.json ? JSON.stringify(voice) : line(voice));
    });
  voices
    .command("create")
    .description(
      "Clone a voice from 1 to 20 local samples (wav, mp3, m4a, opus; 10 s or more of clean speech each); needs --consent",
    )
    .option("--title <name>", "Name of the new voice model")
    .option("--sample <path>", "Audio sample to clone from (repeat up to 20)", collect)
    .option(
      "--transcript <text>",
      "What a sample says, one per --sample in order (omit to let Fish transcribe)",
      collect,
    )
    .option("--description <text>", "Description of the voice")
    .option("--tag <tag>", "Tag (repeatable)", collect)
    .option("--visibility <v>", "private (default) or unlist (anyone with the link)")
    .option("--no-enhance-audio-quality", "Do not clean up the samples before cloning")
    .option("--generate-sample", "Have Fish generate a preview sample")
    .option(
      "--voice-design-signature <sig>",
      "Signature from a `fish voice-design` candidate, one per --sample in order",
      collect,
    )
    .option("--consent", "Confirm you own this voice or have the speaker's permission to clone it")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: FishVoiceCreateOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const input = fishVoiceCreateInput(opts);
      const apiKey = requireFishKey();
      logger.debug(`Cloning ${input.samples.length} sample(s)`);
      const voice = await createFishVoice({ apiKey, ...input });
      const warnings =
        voice.state && voice.state !== "trained"
          ? [
              `voice state is ${voice.state}: check \`multix fish voices get ${voice.id}\` before using it`,
            ]
          : [];
      if (run.json) {
        console.log(JSON.stringify({ ...voice, samples: input.samples.length, warnings }));
        return;
      }
      for (const w of warnings) logger.warn(w);
      logger.success(`Created voice: ${line(voice)}`);
      console.log(`\nUse it with: multix fish tts --voice ${voice.id} --text "..."`);
    });
  voices
    .command("update <id>")
    .description("Edit a voice model's title, description, tags or visibility")
    .option("--title <name>", "New title")
    .option("--description <text>", "New description")
    .option("--tag <tag>", "Replace the tags (repeatable)", collect)
    .option("--visibility <v>", `New visibility: ${FISH_VISIBILITIES.join(", ")}`)
    .option("--yes", "Confirm publishing the voice when --visibility is public")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          tag?: string[];
          visibility?: string;
          yes?: boolean;
        },
      ) => {
        const vis = visibility(opts.visibility);
        if (vis === "public" && !opts.yes) {
          throw new ValidationError(
            "--visibility public lists the voice in the public Fish Audio library; add --yes to confirm",
          );
        }
        const name = title(opts.title);
        if (name === undefined && opts.description === undefined && !opts.tag && !vis) {
          throw new ValidationError(
            "Nothing to change: give --title, --description, --tag or --visibility",
          );
        }
        const voice = await updateFishVoice({
          apiKey: requireFishKey(),
          id: voiceId(id),
          ...(name !== undefined ? { title: name } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.tag ? { tags: opts.tag } : {}),
          ...(vis ? { visibility: vis } : {}),
        });
        console.log(run.json ? JSON.stringify(voice) : `Updated: ${line(voice)}`);
      },
    );
  voices
    .command("delete <id>")
    .description("Delete one of your Fish Audio voice models (cannot be undone); needs --yes")
    .option("--yes", "Confirm the deletion")
    .action(async (id: string, opts: { yes?: boolean }) => {
      const target = voiceId(id);
      if (!opts.yes) {
        throw new ValidationError(
          `Deleting voice ${target} cannot be undone; add --yes to confirm`,
        );
      }
      await deleteFishVoice({ apiKey: requireFishKey(), id: target });
      console.log(run.json ? JSON.stringify({ id: target, deleted: true }) : `Deleted: ${target}`);
    });
}
