/**
 * MiniMax video generation — async submit → poll → download.
 * Mirrors generate_video() in minimax_generate.py.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { apiPost, downloadMinimaxFile, pollAsyncTask } from "../client.js";

interface VideoTaskResponse {
  task_id?: string;
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface VideoResult {
  status: "success" | "error";
  generatedVideo?: string;
  generationTime?: number;
  fileSizeMb?: number;
  model?: string;
  error?: string;
}

export async function generateMinimaxVideo(opts: {
  apiKey: string;
  prompt: string;
  model?: string;
  duration?: 6 | 10;
  resolution?: string;
  firstFrame?: string;
  output?: string;
  thumb?: boolean;
  logger?: Logger;
}): Promise<VideoResult> {
  const {
    apiKey,
    prompt,
    model = "MiniMax-Hailuo-2.3",
    duration = 6,
    resolution = "1080P",
    firstFrame,
    output,
    thumb,
    logger,
  } = opts;

  const payload: Record<string, unknown> = { prompt, model, duration, resolution };
  if (firstFrame) payload.first_frame_image = firstFrame;

  logger?.debug(`Submitting video generation with ${model}...`);

  let taskResp: VideoTaskResponse;
  try {
    taskResp = await apiPost<VideoTaskResponse>("video_generation", payload, apiKey, {
      logger,
      timeoutMs: 60_000,
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const taskId = taskResp.task_id;
  if (!taskId) {
    return { status: "error", error: `No task_id in response: ${JSON.stringify(taskResp)}` };
  }

  logger?.debug(`Task ID: ${taskId}, polling...`);
  const start = Date.now();

  let pollResult: Awaited<ReturnType<typeof pollAsyncTask>>;
  try {
    pollResult = await pollAsyncTask(taskId, "video_generation", apiKey, {
      intervalMs: 10_000,
      timeoutMs: 600_000,
      logger,
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const fileId = pollResult.file_id as string | undefined;
  if (!fileId) {
    return { status: "error", error: `No file_id in poll result: ${JSON.stringify(pollResult)}` };
  }

  const outDir = getOutputDir();
  const dest = path.join(outDir, `minimax_video_${Date.now()}.mp4`);

  try {
    await downloadMinimaxFile(fileId, apiKey, dest, logger);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const elapsed = (Date.now() - start) / 1000;
  const stat = fs.statSync(dest);
  const fileSizeMb = stat.size / (1024 * 1024);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(dest, output);
  }

  await maybeDownloadThumb(pollResult, dest, {
    skip: thumb === false,
    copyTo: output,
    logger,
  });

  logger?.debug(`Generated in ${elapsed.toFixed(1)}s, size: ${fileSizeMb.toFixed(2)} MB`);

  return {
    status: "success",
    generatedVideo: dest,
    generationTime: elapsed,
    fileSizeMb,
    model,
  };
}
