/**
 * Gemini TTS speech generation.
 *
 * Calls generateContent with responseModalities: ["AUDIO"] + speechConfig.
 * Response audio is base64 PCM (s16le, 24kHz, mono). We optionally wrap in a
 * 44-byte RIFF/WAV header for `.wav` output, or save raw bytes as `.pcm`.
 *
 * Single-speaker: prebuiltVoiceConfig.voiceName
 * Multi-speaker:  multiSpeakerVoiceConfig.speakerVoiceConfigs (max 2 speakers).
 *
 * Gemini 3.8 TTS models are served by the Interactions API instead: they read
 * the text verbatim, take delivery direction as speech_metadata `style`, and
 * return WAV by default. We request WAV and strip the header for `.pcm` output.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import {
  createInteraction,
  extractAudio,
  extractInteractionAudio,
  generateContent,
} from "../client.js";
import {
  GEMINI_INTERACTIONS_TTS_MODELS,
  TTS_PCM_BITS_PER_SAMPLE,
  TTS_PCM_CHANNELS,
  TTS_PCM_SAMPLE_RATE,
  type TtsOutputFormat,
} from "../voices.js";

export interface SpeakerVoice {
  speaker: string;
  voice: string;
}

export interface GeminiSpeechResult {
  status: "success" | "error";
  generatedAudio?: string;
  model?: string;
  mimeType?: string;
  error?: string;
}

export interface GeminiSpeechOpts {
  text: string;
  model: string;
  voice?: string;
  speakers?: SpeakerVoice[];
  /** Delivery direction (Gemini 3.8 only), e.g. "cheerful and friendly". */
  style?: string;
  outputFormat: TtsOutputFormat;
  output?: string;
  logger?: Logger;
}

export async function generateGeminiSpeech(opts: GeminiSpeechOpts): Promise<GeminiSpeechResult> {
  const { text, model, voice, speakers, outputFormat, output, logger } = opts;

  if (GEMINI_INTERACTIONS_TTS_MODELS.has(model)) {
    return generateInteractionsSpeech(opts);
  }

  const speechConfig =
    speakers && speakers.length > 0
      ? {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: speakers.map((s) => ({
              speaker: s.speaker,
              voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } },
            })),
          },
        }
      : {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        };

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["AUDIO"],
    speechConfig,
  };

  logger?.debug(`Gemini TTS model=${model} mode=${speakers?.length ? "multi" : "single"}`);

  let resp: Awaited<ReturnType<typeof generateContent>>;
  try {
    resp = await generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      generationConfig,
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const audio = extractAudio(resp);
  if (!audio) return { status: "error", error: "No audio in response" };

  const pcmBytes = Buffer.from(audio.data, "base64");
  const sampleRate = parseSampleRate(audio.mimeType) ?? TTS_PCM_SAMPLE_RATE;

  const outBytes =
    outputFormat === "wav"
      ? wrapPcmInWav(pcmBytes, sampleRate, TTS_PCM_CHANNELS, TTS_PCM_BITS_PER_SAMPLE)
      : pcmBytes;

  const dest = saveSpeech(outBytes, outputFormat, output, logger);
  return { status: "success", generatedAudio: dest, model, mimeType: audio.mimeType };
}

/** Build the Interactions request body for a Gemini 3.8 TTS model. */
export function buildInteractionsSpeechBody(
  opts: Pick<GeminiSpeechOpts, "text" | "model" | "voice" | "speakers" | "style">,
): Record<string, unknown> {
  const { text, model, voice, speakers, style } = opts;
  const speechConfig =
    speakers && speakers.length > 0
      ? { mode: "conversational", speakers: speakers.map((s) => ({ ...s })) }
      : [{ voice }];
  const content: Record<string, unknown> = { type: "text", text };
  if (style) content.annotations = [{ type: "speech_metadata", style }];
  return {
    model,
    input: [{ type: "user_input", content: [content] }],
    response_format: { type: "audio", mime_type: "audio/wav" },
    generation_config: { speech_config: speechConfig },
  };
}

async function generateInteractionsSpeech(opts: GeminiSpeechOpts): Promise<GeminiSpeechResult> {
  const { model, speakers, outputFormat, output, logger } = opts;
  logger?.debug(
    `Gemini TTS (interactions) model=${model} mode=${speakers?.length ? "multi" : "single"}`,
  );

  let resp: unknown;
  try {
    resp = await createInteraction(buildInteractionsSpeechBody(opts));
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const audio = extractInteractionAudio(resp);
  if (!audio) return { status: "error", error: "No audio in response" };

  const bytes = Buffer.from(audio.data, "base64");
  const isWav = bytes.subarray(0, 4).toString("ascii") === "RIFF";
  let outBytes: Buffer;
  if (outputFormat === "wav") {
    outBytes = isWav
      ? bytes
      : wrapPcmInWav(
          bytes,
          parseSampleRate(audio.mimeType) ?? TTS_PCM_SAMPLE_RATE,
          TTS_PCM_CHANNELS,
          TTS_PCM_BITS_PER_SAMPLE,
        );
  } else {
    outBytes = isWav ? extractWavData(bytes) : bytes;
  }

  const dest = saveSpeech(outBytes, outputFormat, output, logger);
  return { status: "success", generatedAudio: dest, model, mimeType: audio.mimeType };
}

/** Return the `data` chunk payload of a RIFF/WAV buffer (raw PCM). */
export function extractWavData(wav: Buffer): Buffer {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length));
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV response has no data chunk");
}

function saveSpeech(
  outBytes: Buffer,
  outputFormat: TtsOutputFormat,
  output: string | undefined,
  logger: Logger | undefined,
): string {
  const outDir = getOutputDir();
  const dest = path.join(outDir, `gemini_speech_${Date.now()}.${outputFormat}`);
  fs.writeFileSync(dest, outBytes);
  logger?.success(`Saved: ${dest} (${(outBytes.length / 1024).toFixed(1)} KB)`);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(dest, output);
    logger?.success(`Copied to: ${output}`);
  }
  return dest;
}

/**
 * Parse sample rate from a `audio/L16;rate=24000` style mime.
 * Returns null if absent.
 */
export function parseSampleRate(mimeType: string): number | null {
  const m = mimeType.match(/rate=(\d+)/i);
  return m ? Number.parseInt(m[1] as string, 10) : null;
}

/**
 * Wrap raw PCM s16le data in a minimal 44-byte RIFF/WAV header.
 * Spec: http://soundfile.sapp.org/doc/WaveFormat/
 */
export function wrapPcmInWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4); // chunk size
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
