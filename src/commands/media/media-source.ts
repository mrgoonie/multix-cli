/**
 * Resolves the local file a media check reads and fingerprints its exact
 * bytes. Inputs are local files only: URLs and ffmpeg protocol prefixes
 * (`concat:`, `pipe:`, `http:`) are refused, so a check never fetches
 * anything or reads from somewhere other than the named file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";

export interface MediaSource {
  /** The path as given. */
  path: string;
  /** Absolute path of the bytes read (symlinks followed). */
  resolved: string;
  symlink: boolean;
  bytes: number;
  sha256: string;
  /** First bytes of the file, for container sniffing. */
  head: Buffer;
}

const HEAD_BYTES = 4096;

/** Refuses anything ffmpeg would treat as a protocol or URL instead of a local path. */
export function assertLocalPath(input: string): void {
  if (!input.trim()) throw new ValidationError("Input path is empty");
  if (/^[a-z][a-z0-9+.,-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input))
    throw new ValidationError(
      `Input must be a local file path, not a URL or protocol (${input.split(":")[0]}:). Download it first.`,
    );
}

/** Streams the file through sha256, keeping only its first bytes in memory. */
export async function hashFile(
  file: string,
): Promise<{ sha256: string; bytes: number; head: Buffer }> {
  const hash = createHash("sha256");
  const headChunks: Buffer[] = [];
  let headLen = 0;
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
    if (headLen < HEAD_BYTES) {
      const part = buf.subarray(0, HEAD_BYTES - headLen);
      headChunks.push(Buffer.from(part));
      headLen += part.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, head: Buffer.concat(headChunks) };
}

export async function resolveMediaSource(input: string): Promise<MediaSource> {
  assertLocalPath(input);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(input);
  } catch {
    throw new ValidationError(`Input not found: ${input}`);
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(input);
  } catch {
    throw new ValidationError(`Input is a broken symlink: ${input}`);
  }
  if (!fs.statSync(resolved).isFile())
    throw new ValidationError(`Input is not a regular file: ${input}`);
  const { sha256, bytes, head } = await hashFile(resolved);
  return {
    path: input,
    resolved: path.resolve(resolved),
    symlink: lstat.isSymbolicLink(),
    bytes,
    sha256,
    head,
  };
}

/**
 * The arguments ffmpeg/ffprobe get for a resolved path: the file protocol only, never a URL.
 * To the image2 demuxer a `%` in the name is a frame-number pattern (`a%03d.png` reads
 * `a000.png`), so such a path also gets `-pattern_type none` to read the file named.
 * ffprobe accepts that option for any input; ffmpeg only for image2, so pass `formatName`.
 */
export function ffInput(
  resolved: string,
  opts: { probe?: boolean; formatName?: string | null } = {},
): string[] {
  const literal =
    resolved.includes("%") && (opts.probe || /(^|,)image2(,|$)/.test(opts.formatName ?? ""));
  return [
    "-protocol_whitelist",
    "file",
    ...(literal ? ["-pattern_type", "none"] : []),
    "-i",
    `file:${resolved}`,
  ];
}
