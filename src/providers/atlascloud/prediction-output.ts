/**
 * Pure helpers for interpreting Atlas Cloud prediction payloads.
 * Runtime-neutral (no node:* imports).
 *
 * A prediction is not always "a list of URLs": speech-to-text and lyric models
 * return the text itself in `outputs[0]`, and the docs warn never to download
 * outputs blindly. Status values vary by model schema, so both the documented
 * set (processing/completed/failed) and the aliases some schemas list are handled.
 */

import { checkUrlSafety } from "../../core/url-safety.js";
import { ATLAS_PROVIDER } from "./models.js";
import type { AtlasPrediction } from "./types.js";

const SUCCESS_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILURE_STATUSES = new Set(["failed", "error", "canceled", "cancelled", "timeout"]);

function norm(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

export function isSuccessStatus(status: unknown): boolean {
  return SUCCESS_STATUSES.has(norm(status));
}

export function isFailureStatus(status: unknown): boolean {
  return FAILURE_STATUSES.has(norm(status));
}

export function isTerminalStatus(status: unknown): boolean {
  return isSuccessStatus(status) || isFailureStatus(status);
}

/** Collapse an `error` field (string or object, "" when absent) to a message. */
export function predictionErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error.trim();
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    for (const key of ["message", "msg", "error", "detail", "reason"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return "";
}

/** Normalize `outputs` / `output` into a list of non-empty strings. */
export function collectOutputs(prediction: AtlasPrediction): string[] {
  const raw = prediction.outputs ?? prediction.output;
  const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const url = ["url", "download_url", "audio_url", "video_url"]
        .map((k) => obj[k])
        .find((v): v is string => typeof v === "string" && v.length > 0);
      out.push(url ?? JSON.stringify(item));
    }
  }
  return out;
}

/**
 * Policy for fetching an output (or thumbnail) URL, applied to every redirect
 * hop: https only, never localhost or a private/special-purpose IP literal, so
 * a spoofed payload or redirect cannot pull from an internal address or
 * downgrade to http. Atlas does not document its output hosts, so no host
 * allow-list is applied. Inline `data:` outputs are not fetched over the
 * network and are not passed through this check. Messages name the host only.
 */
export function checkOutputUrl(url: string): void {
  checkUrlSafety(url, { provider: ATLAS_PROVIDER });
}

/** An output is media when it is an http(s) or data: URI; anything else is text content. */
export function isMediaOutput(value: string): boolean {
  const s = value.trim();
  return /^https?:\/\//i.test(s) || /^data:[^,]*,/i.test(s);
}

export type OutputCategory = "image" | "video" | "audio" | "3d" | "unknown";

// `svg` is deliberately not an "image" here: it is vector markup, and only
// "image" outputs are handed to the WebP converter.
const EXT_CATEGORY: Record<string, OutputCategory> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  aac: "audio",
  m4a: "audio",
  flac: "audio",
  ogg: "audio",
  opus: "audio",
  pcm: "audio",
  glb: "3d",
  gltf: "3d",
  obj: "3d",
  fbx: "3d",
  stl: "3d",
  ply: "3d",
  usdz: "3d",
  usdc: "3d",
  usd: "3d",
  zip: "3d",
};

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/matroska": "mkv",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "model/gltf-binary": "glb",
  "video/quicktime": "mov",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "application/zip": "zip",
};

/** Extension for a response Content-Type (parameters ignored), or undefined if unknown. */
export function extensionForContentType(
  contentType: string | null | undefined,
): string | undefined {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  return mime ? MIME_EXT[mime] : undefined;
}

/** Lower-cased, normalized extension (no dot) of a media output, or undefined. */
export function outputExtension(value: string): string | undefined {
  const s = value.trim();
  const dataMatch = /^data:([^;,]+)/i.exec(s);
  if (dataMatch?.[1]) return MIME_EXT[dataMatch[1].toLowerCase()];
  let pathname: string;
  try {
    pathname = new URL(s).pathname;
  } catch {
    pathname = s.split(/[?#]/)[0] ?? s;
  }
  const m = /\.([a-z0-9]{2,5})$/i.exec(pathname);
  if (!m?.[1]) return undefined;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

export function outputCategory(value: string): OutputCategory {
  const ext = outputExtension(value);
  return ext ? (EXT_CATEGORY[ext] ?? "unknown") : "unknown";
}

/** Fallback extension when an output URL carries none. */
export function defaultExtensionFor(category: OutputCategory | "text"): string {
  switch (category) {
    case "image":
      return "png";
    case "video":
      return "mp4";
    case "audio":
      return "mp3";
    case "3d":
      return "glb";
    case "text":
      return "txt";
    default:
      return "bin";
  }
}

export type ClassifiedOutputs =
  | { mode: "empty" }
  | { mode: "text"; texts: string[] }
  | { mode: "media"; urls: string[]; texts: string[] };

/**
 * Split outputs into downloadable media and text content. Content decides,
 * not the model's declared type: an Audio model may return a transcript.
 */
export function classifyOutputs(prediction: AtlasPrediction): ClassifiedOutputs {
  const outputs = collectOutputs(prediction);
  if (outputs.length === 0) return { mode: "empty" };
  const urls = outputs.filter(isMediaOutput);
  const texts = outputs.filter((o) => !isMediaOutput(o));
  if (urls.length === 0) return { mode: "text", texts };
  return { mode: "media", urls, texts };
}

/** True when the provider flagged any output as NSFW (usually means a safety block). */
export function hasNsfwFlag(prediction: AtlasPrediction): boolean {
  return Array.isArray(prediction.has_nsfw_contents) && prediction.has_nsfw_contents.some(Boolean);
}

/**
 * The part of a prediction that may name a video thumbnail: only the outputs.
 * The rest of the payload can echo request input (reference images, temporary
 * uploads), which must never be saved as if it were a generated thumbnail.
 */
export function thumbnailSource(prediction: AtlasPrediction): unknown {
  return prediction.outputs ?? prediction.output ?? null;
}

/**
 * `atlas-<prediction id>-NN.<ext>` — one deterministic name per output of a
 * prediction. The full (sanitized) id keeps different predictions apart, so a
 * file already under this name is this very output, saved by an earlier run.
 */
export function outputFileName(predictionId: string, index: number, ext: string): string {
  const id = predictionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "output";
  return `atlas-${id}-${String(index + 1).padStart(2, "0")}.${ext}`;
}
