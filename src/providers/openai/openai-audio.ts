import fs from "node:fs";
import path from "node:path";
import { fetchBytes } from "../../core/http-client.js";
import { resolveAudioInput } from "../../core/image-input.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { fileFromPath, postOpenAIBinary, postOpenAIForm, requireOpenAIKey } from "./client.js";
import {
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
  type OpenAITranscriptFormat,
  type OpenAITtsOutputFormat,
  extFromAudioFormat,
  resolveTranscriptionRequestFormat,
  validateKnownSpeakerPairing,
} from "./models.js";

export function buildSpeechBody(opts: {
  text: string;
  model?: string;
  voice: string;
  outputFormat: OpenAITtsOutputFormat;
  instructions?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_OPENAI_TTS_MODEL,
    input: opts.text,
    voice: opts.voice,
    response_format: opts.outputFormat,
  };
  if (opts.instructions) body.instructions = opts.instructions;
  return body;
}

export async function buildTranscriptionForm(opts: {
  input: File;
  model?: string;
  cliFormat: OpenAITranscriptFormat;
  language?: string;
  chunkingStrategy?: string;
  knownSpeakerNames?: string[];
  knownSpeakerReferences?: string[];
}): Promise<FormData> {
  const model = opts.model ?? DEFAULT_OPENAI_STT_MODEL;
  const form = new FormData();
  form.append("file", opts.input);
  form.append("model", model);
  form.append("response_format", resolveTranscriptionRequestFormat(opts.cliFormat, model));
  if (opts.language) form.append("language", opts.language);
  if (opts.chunkingStrategy) form.append("chunking_strategy", opts.chunkingStrategy);

  const names = opts.knownSpeakerNames ?? [];
  const refs = opts.knownSpeakerReferences ?? [];
  validateKnownSpeakerPairing(names, refs);
  for (const name of names) form.append("known_speaker_names[]", name);
  for (const ref of refs) {
    form.append("known_speaker_references[]", await resolveAudioReferenceDataUrl(ref));
  }
  return form;
}

async function resolveAudioReferenceDataUrl(ref: string): Promise<string> {
  const resolved = await resolveAudioInput(ref);
  if (resolved.kind === "data") return resolved.dataUrl;
  const bytes = await fetchBytes(resolved.url);
  return `data:${audioMimeFromReference(resolved.url)};base64,${bytes.toString("base64")}`;
}

function audioMimeFromReference(ref: string): string {
  const pathname = new URL(ref).pathname;
  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".flac":
      return "audio/flac";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

export async function generateOpenAISpeech(opts: {
  text: string;
  model?: string;
  voice: string;
  outputFormat: OpenAITtsOutputFormat;
  instructions?: string;
  output?: string;
  logger?: Logger;
}): Promise<string> {
  const bytes = await postOpenAIBinary("/audio/speech", buildSpeechBody(opts), requireOpenAIKey());
  const ext = extFromAudioFormat(opts.outputFormat);
  const dest = path.join(getOutputDir(), `openai-speech-${Date.now()}.${ext}`);
  fs.writeFileSync(dest, bytes);
  opts.logger?.success(`Saved: ${dest} (${(bytes.length / 1024).toFixed(1)} KB)`);
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(dest, opts.output);
  }
  return dest;
}

export async function transcribeOpenAIAudio(opts: {
  inputPath: string;
  model?: string;
  format: OpenAITranscriptFormat;
  language?: string;
  chunkingStrategy?: string;
  knownSpeakerNames?: string[];
  knownSpeakerReferences?: string[];
  output?: string;
  logger?: Logger;
}): Promise<{ path: string; text?: string }> {
  const form = await buildTranscriptionForm({
    input: fileFromPath(opts.inputPath),
    model: opts.model,
    cliFormat: opts.format,
    language: opts.language,
    chunkingStrategy:
      opts.chunkingStrategy ??
      (opts.model === "gpt-4o-transcribe-diarize" || opts.format === "diarized_json"
        ? "auto"
        : undefined),
    knownSpeakerNames: opts.knownSpeakerNames,
    knownSpeakerReferences: opts.knownSpeakerReferences,
  });
  const data = await postOpenAIForm<Record<string, unknown>>(
    "/audio/transcriptions",
    form,
    requireOpenAIKey(),
    600_000,
  );
  const text = typeof data.text === "string" ? data.text : undefined;
  const ext = opts.format === "text" ? "txt" : "json";
  const dest = opts.output
    ? path.resolve(opts.output)
    : path.join(getOutputDir(), `openai-transcribe-${Date.now()}.${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, opts.format === "text" ? (text ?? "") : JSON.stringify(data, null, 2));
  opts.logger?.success(`Saved transcript: ${dest}`);
  return { path: dest, text };
}
