/**
 * Cheap self-checks on produced files so an agent can tell a good result from
 * a broken one without opening it: size, sha256, MIME from the extension,
 * image dimensions from the header, media duration from ffprobe when it is
 * installed, plus warnings for empty files and content that does not match
 * the extension. Deep checks (black frames, loudness) are `media` territory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readImageHeaderFromFile } from "../core/image-header.js";

export interface OutputFile {
  path: string;
  bytes: number;
  mime: string;
  sha256?: string;
  width?: number;
  height?: number;
  duration_s?: number;
}

export interface OutputWarning {
  code: "EMPTY_OUTPUT" | "CONTENT_MISMATCH" | "UNREADABLE_MEDIA";
  path: string;
  message: string;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  pcm: "audio/pcm",
  ulaw: "audio/basic",
  alaw: "audio/x-alaw-basic",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  fbx: "application/octet-stream",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  csv: "text/csv",
  pdf: "application/pdf",
  zip: "application/zip",
};

// Hashing runs at exit; larger files (long videos) skip it to keep the exit fast.
const HASH_LIMIT = 64 * 1024 * 1024;
let ffprobeAvailable: boolean | undefined;

function hasFfprobe(): boolean {
  if (ffprobeAvailable === undefined) {
    const res = spawnSync("ffprobe", ["-version"], { stdio: "ignore", timeout: 3000 });
    ffprobeAvailable = !res.error && res.status === 0;
  }
  return ffprobeAvailable;
}

function sha256(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: read loop
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Media duration in seconds from ffprobe; undefined when ffprobe is missing or cannot read it. */
export function probeDuration(file: string): number | undefined {
  if (!hasFfprobe()) return undefined;
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8", timeout: 10_000 },
  );
  const value = Number.parseFloat(res.stdout ?? "");
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
}

/** Describe one produced file and collect warnings about it. */
export function inspectOutput(file: string, warnings: OutputWarning[]): OutputFile {
  const ext = path.extname(file).slice(1).toLowerCase();
  const stat = fs.statSync(file);
  const out: OutputFile = {
    path: path.relative(process.cwd(), file) || file,
    bytes: stat.size,
    mime: MIME[ext] ?? "application/octet-stream",
  };
  if (stat.size === 0) {
    warnings.push({ code: "EMPTY_OUTPUT", path: out.path, message: "File is empty" });
    return out;
  }
  if (stat.size <= HASH_LIMIT) out.sha256 = sha256(file);
  if (out.mime.startsWith("image/") && ext !== "gif") {
    const header = readImageHeaderFromFile(file);
    if (header) {
      out.width = header.width;
      out.height = header.height;
      const expected = ext === "jpg" ? "jpeg" : ext;
      if (header.kind !== expected) {
        warnings.push({
          code: "CONTENT_MISMATCH",
          path: out.path,
          message: `Extension .${ext} but the bytes are ${header.kind}`,
        });
      }
    } else {
      warnings.push({
        code: "CONTENT_MISMATCH",
        path: out.path,
        message: `Extension .${ext} but the bytes are not a PNG/JPEG/WebP image`,
      });
    }
  }
  if (out.mime.startsWith("video/") || out.mime.startsWith("audio/")) {
    const duration = probeDuration(file);
    if (duration !== undefined) out.duration_s = duration;
    else if (hasFfprobe()) {
      warnings.push({
        code: "UNREADABLE_MEDIA",
        path: out.path,
        message: "ffprobe could not read a duration; the file may be truncated or not media",
      });
    }
  }
  return out;
}
