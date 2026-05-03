/**
 * Gemini TTS speech generation.
 *
 * Calls generateContent with responseModalities: ["AUDIO"] + speechConfig.
 * Response audio is base64 PCM (s16le, 24kHz, mono). We optionally wrap in a
 * 44-byte RIFF/WAV header for `.wav` output, or save raw bytes as `.pcm`.
 *
 * Single-speaker: prebuiltVoiceConfig.voiceName
 * Multi-speaker:  multiSpeakerVoiceConfig.speakerVoiceConfigs (max 2 speakers).
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { extractAudio, generateContent } from "../client.js";
import {
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
  outputFormat: TtsOutputFormat;
  output?: string;
  logger?: Logger;
}

export async function generateGeminiSpeech(opts: GeminiSpeechOpts): Promise<GeminiSpeechResult> {
  const { text, model, voice, speakers, outputFormat, output, logger } = opts;

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

  const outDir = getOutputDir();
  const dest = path.join(outDir, `gemini_speech_${Date.now()}.${outputFormat}`);
  fs.writeFileSync(dest, outBytes);
  logger?.success(`Saved: ${dest} (${(outBytes.length / 1024).toFixed(1)} KB)`);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(dest, output);
    logger?.success(`Copied to: ${output}`);
  }

  return { status: "success", generatedAudio: dest, model, mimeType: audio.mimeType };
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
