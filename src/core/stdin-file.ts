/**
 * Materialize piped stdin as a temporary file so `--files -` works with
 * commands that need a path (Gemini inline parts, Files API uploads).
 *
 * The extension is detected from magic bytes so MIME type inference keeps
 * working; `--stdin-ext` overrides it. The file lives in a private temp
 * directory (mode 0600) that is removed after use and on process exit.
 * Content and temp paths are never logged; results label the input "stdin".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";

export const STDIN_ARG = "-";
export const STDIN_LABEL = "stdin";
const HEAD_BYTES = 4096;

type StdinLike = AsyncIterable<Buffer | string> & { isTTY?: boolean };

const ascii = (buf: Buffer, start: number, end: number) => buf.toString("latin1", start, end);

/** Best-effort extension from leading bytes; undefined when unknown. */
export function detectExtension(head: Buffer): string | undefined {
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return ".png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (ascii(head, 0, 4) === "GIF8") return ".gif";
  if (ascii(head, 0, 5) === "%PDF-") return ".pdf";
  if (ascii(head, 0, 4) === "RIFF") {
    const kind = ascii(head, 8, 12);
    if (kind === "WEBP") return ".webp";
    if (kind === "WAVE") return ".wav";
    if (kind === "AVI ") return ".avi";
  }
  if (ascii(head, 0, 4) === "OggS") return ".ogg";
  if (ascii(head, 0, 4) === "fLaC") return ".flac";
  if (ascii(head, 0, 4) === "FORM" && ascii(head, 8, 12) === "AIFF") return ".aiff";
  if (ascii(head, 0, 3) === "ID3") return ".mp3";
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand.startsWith("M4A")) return ".m4a";
    if (brand === "qt  ") return ".mov";
    if (brand.startsWith("3gp")) return ".3gpp";
    return ".mp4";
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return ".webm";
  if (head.length >= 2 && head[0] === 0xff) {
    const b1 = head[1] ?? 0;
    if ((b1 & 0xf6) === 0xf0) return ".aac"; // ADTS
    if ((b1 & 0xe0) === 0xe0) return ".mp3"; // MPEG audio frame sync
  }
  if (looksLikeText(head)) return ".txt";
  return undefined;
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0 || head.includes(0)) return false;
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
    throw new ValidationError(`Invalid --stdin-ext: ${ext} (expected e.g. .mp3 or md)`);
  }
  return clean.startsWith(".") ? clean : `.${clean}`;
}

export interface StdinFile {
  path: string;
  size: number;
  cleanup: () => void;
}

/** Read all of stdin into a private temp file. */
export async function stdinToTempFile(
  opts: { input?: StdinLike; ext?: string } = {},
): Promise<StdinFile> {
  const input = opts.input ?? (process.stdin as unknown as StdinLike);
  if (input.isTTY) {
    throw new ValidationError(
      "`--files -` reads piped input, but stdin is a terminal. Example: cat clip.mp3 | multix gemini transcribe --files -",
    );
  }
  const forcedExt = opts.ext ? normalizeExt(opts.ext) : undefined;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-stdin-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const rawPath = path.join(dir, "input");

  let head = Buffer.alloc(0);
  let size = 0;
  try {
    const fd = fs.openSync(rawPath, "w", 0o600);
    try {
      for await (const chunk of input) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (head.length < HEAD_BYTES) {
          head = Buffer.concat([head, buf.subarray(0, HEAD_BYTES - head.length)]);
        }
        fs.writeSync(fd, buf);
        size += buf.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (size === 0) throw new ValidationError("`--files -` was given but stdin was empty");

    const ext = forcedExt ?? detectExtension(head) ?? ".bin";
    const finalPath = path.join(dir, `${STDIN_LABEL}${ext}`);
    fs.renameSync(rawPath, finalPath);
    return { path: finalPath, size, cleanup };
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

/**
 * Resolve `--files` values, replacing a single `-` with piped stdin.
 * Call `cleanup()` when done; it also runs on process exit.
 */
export async function resolveFileInputs(
  files: string[],
  opts: { stdinExt?: string; input?: StdinLike } = {},
): Promise<{ inputs: FileInput[]; cleanup: () => void }> {
  const stdinCount = files.filter((f) => f === STDIN_ARG).length;
  if (stdinCount > 1) throw new ValidationError("`-` (stdin) can only be passed once to --files");
  if (opts.stdinExt && stdinCount === 0) {
    throw new ValidationError("--stdin-ext only applies when --files includes `-`");
  }

  for (const f of files) {
    if (f !== STDIN_ARG && !fs.existsSync(f)) throw new ValidationError(`File not found: ${f}`);
  }

  if (stdinCount === 0) {
    return { inputs: files.map((f) => ({ path: f, label: f })), cleanup: () => {} };
  }

  const stdin = await stdinToTempFile({ input: opts.input, ext: opts.stdinExt });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    process.removeListener("exit", cleanup);
    stdin.cleanup();
  };
  // Commands may call process.exit() on failure; still remove the temp file.
  process.once("exit", cleanup);
  return {
    inputs: files.map((f) =>
      f === STDIN_ARG ? { path: stdin.path, label: STDIN_LABEL } : { path: f, label: f },
    ),
    cleanup,
  };
}
