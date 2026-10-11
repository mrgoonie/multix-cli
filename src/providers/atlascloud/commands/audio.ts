/**
 * multix atlas audio [text] — text-to-speech, music, lyrics, or speech-to-text
 * through POST /model/generateAudio. The model decides the task; speech-to-text
 * and lyric models return text, which is printed (or saved with --output)
 * instead of being treated as a download URL.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { FIELD_CANDIDATES as F } from "../model-input.js";
import { ATLAS_DEFAULT_MODELS } from "../models.js";
import { atlasDefaultModel } from "./env.js";
import { runGenerationCommand } from "./generation-command.js";
import { type RunCliOpts, addRunOptions } from "./prediction-runner.js";

const AUDIO_WAIT_MS = 600_000;
const AUDIO_POLL_MS = 3000;

interface AudioFlags extends RunCliOpts {
  model?: string;
  audio?: string;
  voice?: string;
  format?: string;
  language?: string;
}

export function registerAtlasAudioCommand(parent: Command): void {
  const audio = parent
    .command("audio [text]")
    .description(
      `Speech, music, lyrics or transcription via Atlas Cloud (default TTS: ${ATLAS_DEFAULT_MODELS.tts}; with --audio, STT: ${ATLAS_DEFAULT_MODELS.stt})`,
    )
    .option(
      "-m, --model <id>",
      "Atlas Cloud audio model id (env: ATLASCLOUD_TTS_MODEL / ATLASCLOUD_STT_MODEL)",
    )
    .option("--audio <pathOrUrl>", "Input audio for speech-to-text (local files are uploaded)")
    .option("--voice <id>", "Voice id (model-dependent)")
    .option("--format <fmt>", "Output audio format, e.g. mp3, wav (model-dependent)")
    .option("--language <code>", "Language (model-dependent)");
  addRunOptions(audio, { waitTimeoutMs: AUDIO_WAIT_MS }).action(
    async (text: string | undefined, opts: AudioFlags) => {
      if (!text && !opts.audio) {
        throw new ValidationError(
          "Provide text to synthesize, or --audio <pathOrUrl> to transcribe",
        );
      }
      const model = opts.model ?? atlasDefaultModel(opts.audio ? "stt" : "tts");
      await runGenerationCommand({
        model,
        kind: "audio",
        refs: opts.audio ? [opts.audio] : [],
        requests: (refs) => [
          { flag: "[text]", value: text, candidates: F.speechText },
          { flag: "--audio", value: refs[0], candidates: F.audioInput },
          { flag: "--voice", value: opts.voice, candidates: F.voice },
          { flag: "--format", value: opts.format, candidates: F.audioFormat },
          { flag: "--language", value: opts.language, candidates: F.language },
        ],
        opts,
        hint: "audio",
        defaultWaitTimeoutMs: AUDIO_WAIT_MS,
        pollIntervalMs: AUDIO_POLL_MS,
      });
    },
  );
}
