/**
 * Collect the files a job wrote to `out/` and stream them to the caller's R2
 * bucket. Files are never read into memory: each upload streams from disk.
 */

import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { createR2Uploader, safeOutputName } from "./r2-upload.mjs";

/** Largest single output uploaded; bigger files are listed with `url: null`. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Most output files reported (and uploaded) per job. */
export const MAX_OUTPUT_FILES = 50;

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".glb": "model/gltf-binary",
};

/** Regular files under out/ (recursively), with safe, unique names. Symlinks are skipped. */
export async function collectOutputs(outDir) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(outDir);
  const used = new Set();
  const outputs = [];
  for (const file of found.sort().slice(0, MAX_OUTPUT_FILES)) {
    const base = safeOutputName(file);
    if (!base) continue;
    let name = base;
    for (let i = 1; used.has(name); i++) name = `${i}-${base}`;
    used.add(name);
    outputs.push({ file, name, bytes: (await lstat(file)).size });
  }
  return outputs;
}

/**
 * @param {{ file: string, name: string, bytes: number }[]} files
 * @param {{ r2: object, keyPrefix: string }} upload
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function uploadOutputs(files, upload, options = {}) {
  const r2 = createR2Uploader(upload.r2, { fetch: options.fetch });
  const outputs = [];
  for (const { file, name, bytes } of files) {
    if (bytes > MAX_UPLOAD_BYTES) {
      outputs.push({ name, url: null, bytes });
      continue;
    }
    const type = CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
    const body = Readable.toWeb(createReadStream(file));
    const url = await r2.put(`${upload.keyPrefix}/${name}`, body, type, {
      contentLength: bytes,
      signal: options.signal,
    });
    outputs.push({ name, url, bytes });
  }
  return outputs;
}
