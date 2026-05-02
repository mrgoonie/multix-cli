/**
 * MiniMax music generation — music_generation endpoint.
 * Audio may be a URL or hex-encoded string; handles both.
 * Mirrors generate_music() in minimax_generate.py.
 */

import fs from "node:fs";
import path from "node:path";
import { fetchBytes } from "../../../core/http-client.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { apiPost } from "../client.js";

interface MusicResponse {
  data?: { audio?: string };
  extra_info?: { music_duration?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface MusicResult {
  status: "success" | "error";
  generatedAudio?: string;
  durationMs?: number;
  model?: string;
  error?: string;
}

export async function generateMinimaxMusic(opts: {
  apiKey: string;
  lyrics?: string;
  prompt?: string;
  model?: string;
  outputFormat?: string;
  output?: string;
  logger?: Logger;
}): Promise<MusicResult> {
  const {
    apiKey,
    lyrics = "",
    prompt = "",
    model = "music-2.5",
    outputFormat = "mp3",
    output,
    logger,
  } = opts;

  if (!lyrics && !prompt) {
    return {
      status: "error",
      error: "Either --lyrics or --prompt is required for music generation",
    };
  }

  const payload: Record<string, unknown> = {
    model,
    output_format: "url",
    audio_setting: {
      sample_rate: 44100,
      bitrate: 128000,
      format: outputFormat,
      channel: 1,
    },
  };

  if (lyrics) payload.lyrics = lyrics.slice(0, 3500);
  if (prompt) payload.prompt = prompt.slice(0, 2000);

  logger?.debug(`Generating music with ${model}...`);

  let resp: MusicResponse;
  try {
    resp = await apiPost<MusicResponse>("music_generation", payload, apiKey, {
      logger,
      timeoutMs: 300_000,
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const audioData = resp.data?.audio;
  if (!audioData) {
    return { status: "error", error: "No audio in response" };
  }

  const durationMs = resp.extra_info?.music_duration ?? 0;
  const outDir = getOutputDir();
  const dest = path.join(outDir, `minimax_music_${Date.now()}.${outputFormat}`);

  try {
    if (audioData.startsWith("http")) {
      // URL: stream-download
      const bytes = await fetchBytes(audioData);
      fs.writeFileSync(dest, bytes);
    } else {
      // Hex-encoded
      const audioBytes = Buffer.from(audioData, "hex");
      fs.writeFileSync(dest, audioBytes);
    }
  } catch (e) {
    return {
      status: "error",
      error: `Failed to save audio: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const durSec = durationMs / 1000;
  logger?.success(`Saved: ${dest} (${durSec.toFixed(1)}s)`);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(dest, output);
  }

  return { status: "success", generatedAudio: dest, durationMs, model };
}
