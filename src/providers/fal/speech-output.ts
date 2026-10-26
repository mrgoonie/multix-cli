/**
 * Saves the audio of a fal speech result under the extension its bytes really
 * have. fal URLs may lack an extension or name a different container than the
 * one served, and raw PCM/mu-law/A-law has no header, so the name is chosen
 * from the bytes first, then from the request's format, the result's
 * file_name/content_type, the URL and the response Content-Type. Empty files,
 * error pages and bytes that are not the container they claim are refused.
 */

import fs from "node:fs";
import path from "node:path";
import { audioExtFromMime, looksLikeText, sniffAudioKind } from "../../core/audio-kind.js";
import { ProviderError } from "../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { redactUrl } from "../../core/redact.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { extractMediaUrls } from "./run-helpers.js";

/** Formats without a header: they cannot be sniffed, only trusted from the request. */
const RAW_EXTS = new Set(["pcm", "ulaw", "alaw"]);
/** Containers sniffAudioKind recognises: bytes claiming one of these must match. */
const SNIFFABLE = new Set(["wav", "mp3", "ogg", "flac", "m4a", "aac", "webm", "aiff"]);

export interface SavedAudio {
  path: string;
  format: string;
  bytes: number;
  /** True when the bytes were matched to a known container (always false for raw formats). */
  verified: boolean;
}

interface AudioRef {
  url: string;
  contentType?: string;
  fileName?: string;
}

/** The audio item of a result: `audio` ({url,...} or a URL), else the first media URL. */
export function audioRefOf(result: unknown): AudioRef | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const audio = (result as Record<string, unknown>).audio;
  if (typeof audio === "string" && /^https?:\/\//i.test(audio)) return { url: audio };
  if (audio && typeof audio === "object") {
    const a = audio as Record<string, unknown>;
    if (typeof a.url === "string" && /^https?:\/\//i.test(a.url)) {
      return {
        url: a.url,
        ...(typeof a.content_type === "string" ? { contentType: a.content_type } : {}),
        ...(typeof a.file_name === "string" ? { fileName: a.file_name } : {}),
      };
    }
  }
  const [first] = extractMediaUrls(result);
  return first ? { url: first } : undefined;
}

/** An extension safe to put in a file name; anything else is ignored. */
function safeExt(ext: string | undefined): string | undefined {
  const e = ext?.toLowerCase();
  return e && /^[a-z0-9]{1,5}$/.test(e) ? e : undefined;
}

function extOfName(name: string | undefined): string | undefined {
  return safeExt(name ? path.extname(name).slice(1) : undefined);
}

function extOfUrl(url: string): string | undefined {
  try {
    return extOfName(new URL(url).pathname);
  } catch {
    return undefined;
  }
}

function readHead(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Pick the extension for downloaded bytes; throws when they cannot be the audio they claim. */
export function resolveAudioExt(
  head: Uint8Array,
  hints: { expected?: string; ref: AudioRef; responseType?: string },
): { ext: string; verified: boolean; declared?: string } {
  if (head.length === 0) throw new ProviderError("fal returned an empty audio file", "fal");
  const declared =
    safeExt(hints.expected) ??
    extOfName(hints.ref.fileName) ??
    audioExtFromMime(hints.ref.contentType) ??
    extOfUrl(hints.ref.url) ??
    audioExtFromMime(hints.responseType);
  const raw = declared !== undefined && RAW_EXTS.has(declared);
  // Raw samples can start with any byte, including "<", "{" or "[".
  if (!raw && looksLikeText(head)) {
    throw new ProviderError("fal returned text (an error page or JSON), not audio", "fal");
  }
  const sniffed = sniffAudioKind(head, { frameSync: !raw });
  if (sniffed) return { ext: sniffed, verified: true, ...(declared ? { declared } : {}) };
  if (declared && SNIFFABLE.has(declared)) {
    throw new ProviderError(
      `fal returned audio declared as ${declared}, but the bytes are not ${declared}`,
      "fal",
    );
  }
  if (raw) return { ext: declared, verified: false, declared };
  return { ext: declared ?? "bin", verified: false, ...(declared ? { declared } : {}) };
}

/**
 * Download the audio of `result` to `<outDir>/fal-<requestId>-01.<ext>`.
 * `expectedExt` is what the request asked for (e.g. "pcm"); bytes win over it
 * when they are a recognisable container. A refused or failed download leaves
 * no file behind.
 */
export async function saveSpeechAudio(opts: {
  result: unknown;
  outDir: string;
  requestId: string;
  expectedExt?: string;
  logger: Logger;
}): Promise<SavedAudio> {
  const ref = audioRefOf(opts.result);
  if (!ref) {
    const keys = opts.result && typeof opts.result === "object" ? Object.keys(opts.result) : [];
    throw new ProviderError(
      `fal returned no audio URL (result fields: ${keys.join(", ") || "none"})`,
      "fal",
    );
  }
  const base = `fal-${opts.requestId.replace(/[^A-Za-z0-9_.-]/g, "_")}-01`;
  const tmp = path.join(opts.outDir, `${base}.download`);
  let downloaded: Awaited<ReturnType<typeof downloadToFile>>;
  try {
    downloaded = await downloadToFile(ref.url, {
      dest: tmp,
      maxBytes: maxDownloadBytes(),
      // Every redirect hop: https only, never a local or private address.
      validateUrl: (hop) => {
        checkUrlSafety(hop, { provider: "fal" });
      },
    });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new ProviderError(
      `Audio download failed for ${redactUrl(ref.url)}: ${e instanceof Error ? e.message : e}`,
      "fal",
      { cause: e },
    );
  }
  let resolved: ReturnType<typeof resolveAudioExt>;
  try {
    resolved = resolveAudioExt(readHead(tmp), {
      ...(opts.expectedExt ? { expected: opts.expectedExt } : {}),
      ref,
      ...(downloaded.contentType ? { responseType: downloaded.contentType } : {}),
    });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (resolved.verified && resolved.declared && resolved.declared !== resolved.ext) {
    opts.logger.warn(
      `fal declared ${resolved.declared} audio but the bytes are ${resolved.ext}; saved as .${resolved.ext}`,
    );
  } else if (!resolved.verified && !RAW_EXTS.has(resolved.ext)) {
    opts.logger.warn(`Could not verify the audio container; saved as .${resolved.ext}`);
  }
  const dest = path.join(opts.outDir, `${base}.${resolved.ext}`);
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  opts.logger.success(`Saved ${dest}`);
  return { path: dest, format: resolved.ext, bytes: downloaded.bytes, verified: resolved.verified };
}
