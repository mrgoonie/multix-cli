/**
 * MiniMax speech (TTS) generation — t2a_v2 endpoint.
 * Audio returned as hex-encoded string; decoded to bytes.
 * Mirrors generate_speech() in minimax_generate.py.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { apiPost } from "../client.js";

interface SpeechResponse {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface SpeechResult {
  status: "success" | "error";
  generatedAudio?: string;
  model?: string;
  error?: string;
}

export async function generateMinimaxSpeech(opts: {
  apiKey: string;
  text: string;
  model?: string;
  voice?: string;
  emotion?: string;
  outputFormat?: string;
  rate?: number;
  output?: string;
  logger?: Logger;
}): Promise<SpeechResult> {
  const {
    apiKey,
    text,
    model = "speech-2.8-hd",
    voice = "English_expressive_narrator",
    emotion = "neutral",
    outputFormat = "mp3",
    rate = 1.0,
    output,
    logger,
  } = opts;

  const payload = {
    model,
    text: text.slice(0, 10_000),
    stream: false,
    language_boost: "auto",
    output_format: "hex",
    voice_setting: {
      voice_id: voice,
      speed: rate,
      vol: 1.0,
      pitch: 0,
      emotion,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: outputFormat,
      channel: 1,
    },
  };

  logger?.debug(`Generating speech with ${model}, voice: ${voice}`);

  let resp: SpeechResponse;
  try {
    resp = await apiPost<SpeechResponse>("t2a_v2", payload, apiKey, { logger });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const audioHex = resp.data?.audio;
  if (!audioHex) {
    return { status: "error", error: "No audio in response" };
  }

  const audioBytes = Buffer.from(audioHex, "hex");
  const ext = ["mp3", "wav", "flac"].includes(outputFormat) ? outputFormat : "mp3";
  const outDir = getOutputDir();
  const dest = path.join(outDir, `minimax_speech_${Date.now()}.${ext}`);

  fs.writeFileSync(dest, audioBytes);
  logger?.success(`Saved: ${dest} (${(audioBytes.length / 1024).toFixed(1)} KB)`);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(dest, output);
  }

  return { status: "success", generatedAudio: dest, model };
}
