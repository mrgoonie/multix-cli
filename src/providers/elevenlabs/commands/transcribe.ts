/**
 * multix elevenlabs transcribe — Scribe Speech-to-Text.
 * Endpoint: POST /v1/speech-to-text (multipart, sync).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { apiPostMultipart, readFileAsBlob, requireElevenLabsKey } from "../client.js";
import { ELEVENLABS_STT_MODELS, TASK_DEFAULTS } from "../models.js";

interface SttResp {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: Array<{ text: string; start?: number; end?: number; type?: string }>;
}

export function registerTranscribeCommand(parent: Command): void {
  parent
    .command("transcribe")
    .description("Speech-to-text transcription with Scribe")
    .requiredOption("--input <path>", "Audio or video file to transcribe")
    .option(
      "--model <id>",
      `STT model (${[...ELEVENLABS_STT_MODELS].join("|")})`,
      TASK_DEFAULTS.sttModel,
    )
    .option("--language <code>", "ISO language code (e.g. en); auto-detect if omitted")
    .option("--diarize", "Speaker diarization", false)
    .option("--num-speakers <n>", "Hint for speaker count")
    .option("--tag-audio-events", "Tag laughter/applause/etc.", false)
    .option("--timestamps-granularity <g>", "none|word|character", "word")
    .option("--format <f>", "text|json|srt|vtt", "text")
    .option("--output <path>", "Save to this path (defaults to multix-output)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      const form = new FormData();
      form.append("file", readFileAsBlob(opts.input));
      form.append("model_id", opts.model);
      if (opts.language) form.append("language_code", opts.language);
      if (opts.diarize) form.append("diarize", "true");
      if (opts.numSpeakers) form.append("num_speakers", opts.numSpeakers);
      if (opts.tagAudioEvents) form.append("tag_audio_events", "true");
      form.append("timestamps_granularity", opts.timestampsGranularity);

      logger.debug(`Transcribing ${opts.input} (model=${opts.model})`);
      const data = await apiPostMultipart<SttResp>("speech-to-text", form, apiKey, {
        timeoutMs: 600_000,
      });

      const ext =
        opts.format === "json"
          ? "json"
          : opts.format === "srt"
            ? "srt"
            : opts.format === "vtt"
              ? "vtt"
              : "txt";
      const dir = getOutputDir();
      const dest = opts.output
        ? path.resolve(opts.output)
        : path.join(dir, `elevenlabs_transcribe_${Date.now()}.${ext}`);

      let body: string;
      switch (opts.format) {
        case "json":
          body = JSON.stringify(data, null, 2);
          break;
        case "srt":
          body = wordsToSrt(data.words ?? []);
          break;
        case "vtt":
          body = wordsToVtt(data.words ?? []);
          break;
        default:
          body = data.text ?? "";
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      logger.success(`Saved transcript: ${dest}`);
      if (data.language_code) {
        logger.info(
          `Detected language: ${data.language_code} (p=${data.language_probability ?? "?"})`,
        );
      }
      if (opts.format === "text") console.log(`\n${body.trim()}`);
    });
}

function fmtTimeSrt(s: number): string {
  const hh = Math.floor(s / 3600)
    .toString()
    .padStart(2, "0");
  const mm = Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.round((s - Math.floor(s)) * 1000)
    .toString()
    .padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

function fmtTimeVtt(s: number): string {
  return fmtTimeSrt(s).replace(",", ".");
}

function wordsToSrt(words: Array<{ text: string; start?: number; end?: number }>): string {
  const lines: string[] = [];
  words.forEach((w, i) => {
    if (w.start === undefined || w.end === undefined) return;
    lines.push(`${i + 1}\n${fmtTimeSrt(w.start)} --> ${fmtTimeSrt(w.end)}\n${w.text}\n`);
  });
  return lines.join("\n");
}

function wordsToVtt(words: Array<{ text: string; start?: number; end?: number }>): string {
  const lines: string[] = ["WEBVTT", ""];
  for (const w of words) {
    if (w.start === undefined || w.end === undefined) continue;
    lines.push(`${fmtTimeVtt(w.start)} --> ${fmtTimeVtt(w.end)}`);
    lines.push(w.text);
    lines.push("");
  }
  return lines.join("\n");
}
