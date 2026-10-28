/**
 * Path, media-type and digest rules for skill files, shared by the built-in
 * catalog generator and the registry. A path is relative, `/`-separated and
 * made of plain segments: no `.`/`..`, no hidden or empty segments, no
 * backslashes, percent signs or control characters, so it can never leave
 * the skill directory once joined to a skill URI.
 */

import { MAX_FILES_PER_SKILL, type SkillFile } from "./skill-types.js";

export const MAX_PATH_CHARS = 256;
export const MAX_PATH_DEPTH = 8;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Media types by extension; a file with any other extension is refused. */
const MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  py: "text/x-python",
  sh: "text/x-shellscript",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return false;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) return false;
  return segments.every((s) => SEGMENT_RE.test(s) && !/\.\.|\.$/.test(s));
}

/** Media type for a safe path, or undefined when the extension is not served. */
export function mediaTypeFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
}

/** Text files are returned as `text`, everything else as base64 `blob`. */
/**
 * The text of a served text file: valid UTF-8 without a byte-order mark, so
 * the text handed to clients encodes back to exactly the hashed bytes.
 */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/yaml" ||
    mediaType === "application/xml" ||
    mediaType === "image/svg+xml"
  );
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256:<hex>` of the raw bytes, the digest format of the Skills extension. */
export async function sha256Digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
}

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Digest of a revision's whole file set: sha256 over `path digest\n` lines
 * sorted by path. Two revisions with the same files have the same digest.
 */
export async function manifestDigest(files: readonly SkillFile[]): Promise<string> {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path} ${f.digest}\n`)
    .join("");
  return sha256Digest(new TextEncoder().encode(lines));
}

/** Checks shared by every file set: safe unique paths, served types, a root SKILL.md, limits. */
export function fileSetProblem(
  files: readonly { path: string; size: number }[],
  limits: { maxFiles: number; maxBytes: number; maxFileBytes: number },
): string | undefined {
  if (files.length === 0) return "a skill needs at least SKILL.md";
  if (files.length > Math.min(limits.maxFiles, MAX_FILES_PER_SKILL)) {
    return `a skill may have at most ${limits.maxFiles} files`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) return `unsafe file path "${file.path.slice(0, 80)}"`;
    if (seen.has(file.path)) return `duplicate file path "${file.path}"`;
    seen.add(file.path);
    if (!mediaTypeFor(file.path)) return `unsupported file type "${file.path}"`;
    if (file.size > limits.maxFileBytes) {
      return `"${file.path}" is larger than ${limits.maxFileBytes} bytes`;
    }
    total += file.size;
  }
  if (!seen.has("SKILL.md")) return "a skill needs SKILL.md at its root";
  if (total > limits.maxBytes) return `a skill may hold at most ${limits.maxBytes} bytes`;
  return undefined;
}
