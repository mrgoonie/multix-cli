/**
 * Seedance video generation — async ARK tasks API.
 *   POST /contents/generations/tasks   → { id }
 *   GET  /contents/generations/tasks/{id} → status + content.video_url
 *
 * Param encoding:
 *   - flags (default): append `--rs 1080p --dur 8 --rt 16:9 ...` inside content[0].text
 *   - structured: emit top-level `parameters` object
 */

import { downloadFile } from "../../../core/http-client.js";
import { type ResolvedImage, refUrl } from "../../../core/image-input.js";
import type { Logger } from "../../../core/logger.js";
import { poll } from "../../leonardo/poll.js";
import type { BytePlusClient } from "../client.js";
import { BYTEPLUS_DEFAULTS, type VideoParamsMode, bytePlusVideoParamsMode } from "../models.js";
import type {
  ResolvedRef,
  VideoContentItem,
  VideoTaskRequest,
  VideoTaskResponse,
  VideoTaskStatus,
} from "../types.js";

export interface BuildVideoBodyOptions {
  model: string;
  prompt: string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  audio?: boolean;
  seed?: number;
  negativePrompt?: string;
  cameraFixed?: boolean;
  imageInputs?: ResolvedImage[];
  references?: ResolvedRef[];
  paramsMode?: VideoParamsMode;
}

function buildFlagSuffix(opts: BuildVideoBodyOptions): string {
  const parts: string[] = [];
  if (opts.resolution) parts.push(`--rs ${opts.resolution}`);
  if (opts.duration !== undefined) parts.push(`--dur ${opts.duration}`);
  if (opts.aspectRatio) parts.push(`--rt ${opts.aspectRatio}`);
  if (opts.cameraFixed !== undefined) parts.push(`--cf ${opts.cameraFixed}`);
  if (opts.seed !== undefined) parts.push(`--seed ${opts.seed}`);
  if (opts.audio !== undefined) parts.push(`--wm ${opts.audio}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function buildVideoTaskBody(opts: BuildVideoBodyOptions): VideoTaskRequest {
  const mode = opts.paramsMode ?? bytePlusVideoParamsMode();
  const text =
    mode === "flags"
      ? `${opts.prompt}${buildFlagSuffix(opts)}${opts.negativePrompt ? ` negative: "${opts.negativePrompt}"` : ""}`
      : opts.prompt;

  const content: VideoContentItem[] = [{ type: "text", text }];

  for (const img of opts.imageInputs ?? []) {
    content.push({ type: "image_url", image_url: { url: refUrl(img) } });
  }
  for (const ref of opts.references ?? []) {
    if (ref.kind === "image") {
      content.push({
        type: "image_url",
        image_url: { url: ref.url, ...(ref.role ? { role: ref.role } : {}) },
      });
    } else if (ref.kind === "video") {
      content.push({
        type: "video_url",
        video_url: { url: ref.url, ...(ref.role ? { role: ref.role } : {}) },
      });
    } else {
      content.push({
        type: "audio_url",
        audio_url: { url: ref.url, ...(ref.role ? { role: ref.role } : {}) },
      });
    }
  }

  const body: VideoTaskRequest = { model: opts.model, content };

  if (mode === "structured") {
    body.parameters = {
      ...(opts.resolution ? { resolution: opts.resolution } : {}),
      ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
      ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
      ...(opts.audio !== undefined ? { audio: opts.audio } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}),
      ...(opts.cameraFixed !== undefined ? { camera_fixed: opts.cameraFixed } : {}),
    };
  }

  return body;
}

export async function submitVideoTask(
  client: BytePlusClient,
  body: VideoTaskRequest,
  logger?: Logger,
): Promise<VideoTaskResponse> {
  return client.post<VideoTaskResponse>("/contents/generations/tasks", body, logger);
}

export async function getVideoTaskStatus(
  client: BytePlusClient,
  id: string,
  logger?: Logger,
): Promise<VideoTaskStatus> {
  return client.get<VideoTaskStatus>(`/contents/generations/tasks/${id}`, undefined, logger);
}

export interface WaitForVideoOptions {
  intervalMs?: number;
  maxAttempts?: number;
  waitTimeoutMs?: number;
  logger?: Logger;
}

export async function waitForVideoTask(
  client: BytePlusClient,
  id: string,
  opts: WaitForVideoOptions = {},
): Promise<VideoTaskStatus> {
  const intervalMs = opts.intervalMs ?? 4000;
  const maxAttempts =
    opts.maxAttempts ??
    (opts.waitTimeoutMs ? Math.max(1, Math.ceil(opts.waitTimeoutMs / intervalMs)) : 120);
  return poll<VideoTaskStatus>({
    fetch: () => getVideoTaskStatus(client, id, opts.logger),
    done: (v) => v.status === "succeeded",
    failed: (v) => v.status === "failed" || v.status === "cancelled",
    intervalMs,
    maxAttempts,
    onTick: (attempt, v) => opts.logger?.debug(`attempt ${attempt} — status: ${v.status}`),
  });
}

export async function downloadVideo(
  url: string,
  outputPath: string,
  logger?: Logger,
): Promise<void> {
  await downloadFile(url, outputPath);
  logger?.success(`Saved ${outputPath}`);
}
