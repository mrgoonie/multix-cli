/**
 * BytePlus 3D generation — async ARK tasks API (Hyper3D / Hitem3d).
 *   POST /contents/generations/tasks   → { id }
 *   GET  /contents/generations/tasks/{id} → status + content.file_url
 *
 * Both model families share the request shape used by Seedance video tasks:
 *   { model, content: [{type:"text",text:"<prompt> --flag value …"},
 *                       {type:"image_url",image_url:{url:"…"}} … ], seed? }
 *
 * Provider-specific knobs (mesh_mode, hd_texture, material, ff, resolution, …)
 * are passed as raw flag strings appended to the text segment — multix exposes
 * a single `--flags` pass-through to keep the CLI surface stable across the
 * Hyper3D / Hitem3d divergence.
 */

import { downloadFile } from "../../../core/http-client.js";
import type { Logger } from "../../../core/logger.js";
import { poll } from "../../leonardo/poll.js";
import type { BytePlusClient } from "../client.js";
import { type ResolvedImage, refUrl } from "../image-input.js";
import type {
  Model3DTaskRequest,
  Model3DTaskStatus,
  VideoContentItem,
  VideoTaskResponse,
} from "../types.js";

export interface BuildThreeDBodyOptions {
  model: string;
  prompt?: string;
  /** Raw flag string appended to the text segment, e.g. "--mesh_mode Raw --hd_texture true". */
  flags?: string;
  seed?: number;
  imageInputs?: ResolvedImage[];
}

export function buildThreeDTaskBody(opts: BuildThreeDBodyOptions): Model3DTaskRequest {
  const promptText = (opts.prompt ?? "").trim();
  const flagPart = opts.flags?.trim() ?? "";
  const text = [promptText, flagPart].filter((s) => s.length > 0).join(" ");

  const content: VideoContentItem[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const img of opts.imageInputs ?? []) {
    content.push({ type: "image_url", image_url: { url: refUrl(img) } });
  }

  if (content.length === 0) {
    throw new Error("3D task requires either a prompt or at least one image input.");
  }

  const body: Model3DTaskRequest = { model: opts.model, content };
  if (opts.seed !== undefined) body.seed = opts.seed;
  return body;
}

export async function submitThreeDTask(
  client: BytePlusClient,
  body: Model3DTaskRequest,
  logger?: Logger,
): Promise<VideoTaskResponse> {
  return client.post<VideoTaskResponse>("/contents/generations/tasks", body, logger);
}

export async function getThreeDTaskStatus(
  client: BytePlusClient,
  id: string,
  logger?: Logger,
): Promise<Model3DTaskStatus> {
  return client.get<Model3DTaskStatus>(`/contents/generations/tasks/${id}`, undefined, logger);
}

export interface WaitForThreeDOptions {
  intervalMs?: number;
  maxAttempts?: number;
  waitTimeoutMs?: number;
  logger?: Logger;
}

export async function waitForThreeDTask(
  client: BytePlusClient,
  id: string,
  opts: WaitForThreeDOptions = {},
): Promise<Model3DTaskStatus> {
  const intervalMs = opts.intervalMs ?? 4000;
  const maxAttempts =
    opts.maxAttempts ??
    (opts.waitTimeoutMs ? Math.max(1, Math.ceil(opts.waitTimeoutMs / intervalMs)) : 180);
  return poll<Model3DTaskStatus>({
    fetch: () => getThreeDTaskStatus(client, id, opts.logger),
    done: (v) => v.status === "succeeded",
    failed: (v) => v.status === "failed" || v.status === "cancelled",
    intervalMs,
    maxAttempts,
    onTick: (attempt, v) => opts.logger?.debug(`attempt ${attempt} — status: ${v.status}`),
  });
}

/** Detect a 3D model file extension from a URL. Falls back to `glb`. */
export function inferModelFileExt(url: string): string {
  const m = url.match(/\.(glb|gltf|obj|fbx|usdz|stl|ply|zip)(?:\?|#|$)/i);
  return m?.[1] ? m[1].toLowerCase() : "glb";
}

export async function downloadModelFile(
  url: string,
  outputPath: string,
  logger?: Logger,
): Promise<void> {
  await downloadFile(url, outputPath);
  logger?.success(`Saved ${outputPath}`);
}
