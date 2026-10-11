/**
 * Materialize piped stdin as a temporary file so `--files -` (gemini) and
 * `--input -` (doc convert) work with commands that need a path (Gemini
 * inline parts, Files API uploads).
 *
 * The extension is detected from magic bytes so MIME type inference keeps
 * working; `--stdin-ext` overrides it. The file lives in a private temp
 * directory (mode 0600) that is removed after use, on process exit, and on
 * SIGINT/SIGTERM/SIGHUP. Content and temp paths are never logged; results
 * label the input "<stdin>".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";

export const STDIN_ARG = "-";
/** Result label for piped input; angle brackets keep it distinct from a real file named "stdin". */
export const STDIN_LABEL = "<stdin>";
const HEAD_BYTES = 4096;
/** Gemini's Files API limit; larger input could never be sent. */
export const MAX_STDIN_BYTES = 2 * 1024 ** 3;
const WAIT_HINT_MS = 2000;

export type StdinLike = AsyncIterable<Buffer | string> & { isTTY?: boolean };

const ascii = (buf: Buffer, start: number, end: number) => buf.toString("latin1", start, end);

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** A plausible MPEG audio frame header (sync, version, layer, bitrate, sample rate). */
function isMpegAudioFrame(head: Buffer): boolean {
  if (head.length < 4 || head[0] !== 0xff) return false;
  const b1 = head[1] ?? 0;
  const b2 = head[2] ?? 0;
  if ((b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrate = b2 >> 4;
  const sampleRate = (b2 >> 2) & 0x03;
  return (
    version !== 0x01 &&
    layer !== 0x00 &&
    bitrate !== 0x0f &&
    bitrate !== 0x00 &&
    sampleRate !== 0x03
  );
}

/** Best-effort extension from leading bytes; undefined when unknown. */
export function detectExtension(head: Buffer): string | undefined {
  // Byte-order marks first: UTF-16 text would otherwise look like an MP3 frame.
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return ".txt";
  if (
    head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  ) {
    return undefined; // UTF-16 text: Gemini expects UTF-8, so ask for --stdin-ext
  }
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return ".png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (ascii(head, 0, 4) === "GIF8") return ".gif";
  if (ascii(head, 0, 5) === "%PDF-") return ".pdf";
  if (ascii(head, 0, 2) === "BM" && head.length >= 26 && head.readUInt32LE(14) >= 12) return ".bmp";
  if (ascii(head, 0, 4) === "RIFF") {
    const kind = ascii(head, 8, 12);
    if (kind === "WEBP") return ".webp";
    if (kind === "WAVE") return ".wav";
    if (kind === "AVI ") return ".avi";
  }
  if (ascii(head, 0, 4) === "OggS") return ".ogg";
  if (ascii(head, 0, 4) === "fLaC") return ".flac";
  if (ascii(head, 0, 4) === "FORM" && ascii(head, 8, 12) === "AIFF") return ".aiff";
  // ID3v2 tag: "ID3", major version 2-4, then a non-0xFF revision byte.
  if (
    ascii(head, 0, 3) === "ID3" &&
    (head[3] ?? 0) >= 2 &&
    (head[3] ?? 0) <= 4 &&
    head[4] !== 0xff
  ) {
    return ".mp3";
  }
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (HEIF_BRANDS.has(brand)) return ".heic";
    if (AVIF_BRANDS.has(brand)) return undefined; // not a Gemini input type
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return ".m4a";
    if (brand === "qt  ") return ".mov";
    if (brand.startsWith("3g")) return ".3gpp";
    return ".mp4";
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML: WebM declares its DocType near the start; Matroska is not a Gemini type.
    return head.includes("webm", 0, "latin1") ? ".webm" : undefined;
  }
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) return ".aac"; // ADTS
  if (isMpegAudioFrame(head)) return ".mp3";
  if (looksLikeText(head)) return ".txt";
  return undefined;
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  for (const byte of head) {
    // Allow tab, LF, FF, CR and ESC; other C0 control bytes mean binary data.
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0c &&
      byte !== 0x0d &&
      byte !== 0x1b
    ) {
      return false;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function normalizeExt(ext: string): string {
  const clean = ext.trim().toLowerCase();
  if (!/^\.?[a-z0-9]{1,10}$/.test(clean)) {
    throw new ValidationError(`Invalid --stdin-ext: ${ext} (expected e.g. .mp3 or txt)`);
  }
  return clean.startsWith(".") ? clean : `.${clean}`;
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Remove `dir` when the process exits or is interrupted. Returns a dispose
 * function that removes the directory now and unregisters the handlers.
 * Removal never throws: a leftover temp file must not hide finished results.
 */
function trackTempDir(dir: string): () => void {
  let done = false;
  const remove = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Best effort (e.g. antivirus holding the file on Windows); the OS temp dir is cleaned eventually.
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    dispose();
    // Re-raise so the default behaviour (exit code 128+n) still applies.
    process.kill(process.pid, signal);
  };
  const dispose = () => {
    if (done) return;
    done = true;
    process.removeListener("exit", dispose);
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    remove();
  };
  process.once("exit", dispose);
  for (const s of SIGNALS) process.once(s, onSignal);
  return dispose;
}

export interface StdinFile {
  path: string;
  size: number;
  /** False when the type could not be detected and no extension was forced. */
  detected: boolean;
  cleanup: () => void;
}

/** How the calling command spells its stdin argument, used in user-facing messages. */
export interface StdinUsage {
  /** Option that accepts `-`, e.g. "--files" or "--input". */
  flag?: string;
  /** Example command line shown when stdin is a terminal. */
  example?: string;
  /** Extension suggested when the piped type cannot be detected, e.g. "mp3" or "pdf". */
  extExample?: string;
}

const DEFAULT_FLAG = "--files";
const DEFAULT_EXAMPLE = "cat clip.mp3 | multix gemini transcribe --files -";
const DEFAULT_EXT_EXAMPLE = "mp3";

/** Read all of stdin into a private temp file. */
export async function stdinToTempFile(
  opts: { input?: StdinLike; ext?: string; maxBytes?: number } & StdinUsage = {},
): Promise<StdinFile> {
  const input = opts.input ?? (process.stdin as unknown as StdinLike);
  const flag = opts.flag ?? DEFAULT_FLAG;
  if (input.isTTY) {
    throw new ValidationError(
      `\`${flag} -\` reads piped input, but stdin is a terminal. Example: ${opts.example ?? DEFAULT_EXAMPLE}`,
    );
  }
  const forcedExt = opts.ext ? normalizeExt(opts.ext) : undefined;
  const maxBytes = opts.maxBytes ?? MAX_STDIN_BYTES;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-stdin-"));
  // Registered before reading so Ctrl+C mid-read still removes the data.
  const cleanup = trackTempDir(dir);
  const rawPath = path.join(dir, "input");

  // A pipe that never sends data would otherwise hang silently.
  const hint = setTimeout(() => {
    process.stderr.write(`Waiting for data on stdin (\`${flag} -\`)... press Ctrl+C to cancel\n`);
  }, WAIT_HINT_MS);
  hint.unref?.();

  let head = Buffer.alloc(0);
  let size = 0;
  try {
    const fd = fs.openSync(rawPath, "w", 0o600);
    try {
      for await (const chunk of input) {
        clearTimeout(hint);
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (size + buf.length > maxBytes) {
          throw new ValidationError(
            `Piped stdin exceeds ${Math.floor(maxBytes / 1024 ** 2)} MB; save it to a file instead`,
          );
        }
        if (head.length < HEAD_BYTES) {
          head = Buffer.concat([head, buf.subarray(0, HEAD_BYTES - head.length)]);
        }
        let offset = 0;
        while (offset < buf.length) offset += fs.writeSync(fd, buf, offset);
        size += buf.length;
      }
    } finally {
      clearTimeout(hint);
      fs.closeSync(fd);
    }
    if (size === 0) throw new ValidationError(`\`${flag} -\` was given but stdin was empty`);

    const detectedExt = forcedExt ?? detectExtension(head);
    const finalPath = path.join(dir, `stdin${detectedExt ?? ".bin"}`);
    fs.renameSync(rawPath, finalPath);
    return { path: finalPath, size, detected: detectedExt !== undefined, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export interface FileInput {
  /** Path to read from (a temp file for stdin). */
  path: string;
  /** Name shown in logs and results. */
  label: string;
}

/** Replace a temp stdin path inside an error message with its label. */
export function labelError(message: string, input: FileInput): string {
  return input.path === input.label ? message : message.split(input.path).join(input.label);
}

/**
 * Resolve file arguments (`--files` by default), replacing a single `-` with piped stdin.
 * Call `cleanup()` when done; it also runs on exit and on interrupt signals.
 */
export async function resolveFileInputs(
  files: string[],
  opts: { stdinExt?: string; input?: StdinLike; maxBytes?: number } & StdinUsage = {},
): Promise<{ inputs: FileInput[]; cleanup: () => void }> {
  const flag = opts.flag ?? DEFAULT_FLAG;
  const stdinCount = files.filter((f) => f === STDIN_ARG).length;
  if (stdinCount > 1) throw new ValidationError(`\`-\` (stdin) can only be passed once to ${flag}`);
  if (opts.stdinExt && stdinCount === 0) {
    throw new ValidationError(`--stdin-ext only applies when ${flag} includes \`-\``);
  }

  for (const f of files) {
    if (f !== STDIN_ARG && !fs.existsSync(f)) throw new ValidationError(`File not found: ${f}`);
  }

  if (stdinCount === 0) {
    return { inputs: files.map((f) => ({ path: f, label: f })), cleanup: () => {} };
  }

  const stdin = await stdinToTempFile({
    input: opts.input,
    ext: opts.stdinExt,
    maxBytes: opts.maxBytes,
    flag: opts.flag,
    example: opts.example,
  });
  if (!stdin.detected) {
    stdin.cleanup();
    throw new ValidationError(
      `Could not detect the type of piped stdin; pass --stdin-ext (e.g. --stdin-ext ${opts.extExample ?? DEFAULT_EXT_EXAMPLE})`,
    );
  }
  return {
    inputs: files.map((f) =>
      f === STDIN_ARG ? { path: stdin.path, label: STDIN_LABEL } : { path: f, label: f },
    ),
    cleanup: stdin.cleanup,
  };
}
