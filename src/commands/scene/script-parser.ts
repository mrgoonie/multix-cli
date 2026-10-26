/**
 * Scene scripts: one plain-text file per scene.
 *
 *   # scene: s01            (optional; defaults to the file name)
 *   # title: Rooftop at dawn
 *   HIRO: Xin chào, Mai.
 *   MAI (whispering): Anh đến muộn.
 *     continuation lines join the line above
 *
 * Other `#` lines are comments. Text is NFC-normalised so the same
 * Vietnamese words typed with composed or decomposed diacritics hash alike.
 * Lines longer than a model accepts are split at sentence, then word,
 * boundaries; no part exceeds the limit.
 */

import { ValidationError } from "../../core/errors.js";

export interface ScriptLine {
  speaker: string;
  /** Delivery direction from `NAME (direction): text`. */
  direction?: string;
  text: string;
  /** 1-based line number in the script file. */
  sourceLine: number;
}

export interface ParsedScript {
  scene: string;
  title?: string;
  lines: ScriptLine[];
}

const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIALOGUE = /^([^\s:：(][^:：(]{0,63}?)\s*(?:\(([^)]{1,200})\))?\s*[:：]\s*(.*)$/u;

export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Length in Unicode code points (what providers bill and limit). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export function parseScript(source: string, fallbackScene: string): ParsedScript {
  let scene = fallbackScene;
  let title: string | undefined;
  const lines: ScriptLine[] = [];
  source
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const lineNo = i + 1;
      const line = raw.normalize("NFC").trim();
      if (!line) return;
      if (line.startsWith("#")) {
        const meta = line.match(/^#\s*(scene|title)\s*:\s*(.+)$/i);
        if (meta?.[1]?.toLowerCase() === "scene") scene = (meta[2] ?? "").trim();
        else if (meta) title = (meta[2] ?? "").trim();
        return;
      }
      const m = line.match(DIALOGUE);
      if (m && /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test((m[1] ?? "").trim())) {
        const text = normalizeText(m[3] ?? "");
        lines.push({
          speaker: (m[1] ?? "").trim(),
          ...(m[2] ? { direction: normalizeText(m[2]) } : {}),
          text,
          sourceLine: lineNo,
        });
        return;
      }
      const last = lines.at(-1);
      if (!last) {
        throw new ValidationError(
          `${fallbackScene}:${lineNo}: expected "SPEAKER: text" before any continuation line`,
        );
      }
      last.text = normalizeText(`${last.text} ${line}`);
    });
  if (!SCENE_ID.test(scene)) {
    throw new ValidationError(
      `Scene id "${scene}" must be letters, digits, "_" or "-" (set "# scene: <id>")`,
    );
  }
  for (const l of lines) {
    if (!l.text) throw new ValidationError(`${scene}:${l.sourceLine}: line has no text`);
  }
  if (lines.length === 0) throw new ValidationError(`Scene "${scene}" has no dialogue lines`);
  return { scene, ...(title ? { title } : {}), lines };
}

/** Split `text` into parts of at most `maxChars` code points. */
export function chunkText(text: string, maxChars: number): string[] {
  if (charCount(text) <= maxChars) return [text];
  const sentences = text.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)\s*/gu) ?? [text];
  const parts: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (charCount(current + sentence) <= maxChars) {
      current += sentence;
      continue;
    }
    push();
    if (charCount(sentence) <= maxChars) {
      current = sentence;
      continue;
    }
    for (const word of sentence.split(/(\s+)/)) {
      if (charCount(current + word) <= maxChars) {
        current += word;
        continue;
      }
      push();
      // A single word longer than the limit: cut by code point.
      const chars = Array.from(word.trim());
      while (chars.length > maxChars) parts.push(chars.splice(0, maxChars).join(""));
      current = chars.join("");
    }
  }
  push();
  return parts;
}

/** SSML-looking tags and bracketed audio tags in a line. */
export function markupIn(text: string): { ssml: string[]; audioTags: string[] } {
  const ssml = [...text.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)].map((m) => m[0]);
  const audioTags = [...text.matchAll(/\[[\p{L}][\p{L} ,'-]{0,40}\]/gu)].map((m) => m[0]);
  return { ssml, audioTags };
}
