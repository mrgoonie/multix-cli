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
 * boundaries, never inside a `<…>` or `[…]` tag.
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

export const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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

/**
 * Text tokens for splitting. A complete `<…>` tag or `[…]` audio tag is one
 * token that is never cut; full-width sentence ends (。！？) end a sentence
 * wherever they stand; anything else runs up to the next space or tag.
 * Every character lands in exactly one token, so nothing is dropped.
 */
const TOKEN = /(<[^<>]*>|\[[^[\]]*\])|(\s+)|([。！？]+[」』"'”’)]*)|([^\s<[。！？]+|[<[])/gu;
/** `.`, `!`, `?` or `…` (plus closing quotes) at the end of a word. */
const WORD_SENTENCE_END = /[.!?…]+["'”’)\]]*$/u;

interface Token {
  text: string;
  /** A whole tag: never cut. */
  tag: boolean;
  space: boolean;
  sentenceEnd: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [...text.matchAll(TOKEN)].map((m) => ({
    text: m[0],
    tag: m[1] !== undefined,
    space: m[2] !== undefined,
    sentenceEnd: m[3] !== undefined,
  }));
  // "3.5" and time="1.5s" are not sentence ends: a stop counts only before a
  // space or the end of the line.
  tokens.forEach((t, i) => {
    const next = tokens[i + 1];
    if (!t.tag && !t.space && WORD_SENTENCE_END.test(t.text) && (!next || next.space)) {
      t.sentenceEnd = true;
    }
  });
  return tokens;
}

/** Sentences as token runs; a sentence keeps the space that follows it. */
function sentencesOf(tokens: Token[]): Token[][] {
  const sentences: Token[][] = [];
  let current: Token[] = [];
  tokens.forEach((t, i) => {
    current.push(t);
    const ended = t.sentenceEnd || (t.space && tokens[i - 1]?.sentenceEnd);
    if (ended && !(t.sentenceEnd && tokens[i + 1]?.space)) {
      sentences.push(current);
      current = [];
    }
  });
  if (current.length) sentences.push(current);
  return sentences;
}

/** Words and the spaces between them, each as its own token run. */
function wordsOf(sentence: Token[]): Token[][] {
  const words: Token[][] = [];
  for (const t of sentence) {
    const last = words.at(-1);
    if (t.space || !last || last[0]?.space) words.push([t]);
    else last.push(t);
  }
  return words;
}

const joined = (tokens: Token[]) => tokens.map((t) => t.text).join("");

/**
 * Split `text` into parts of at most `maxChars` code points, at sentence,
 * then word boundaries. Tags are never cut: a single tag longer than the
 * limit becomes a part of its own, which planScenes reports as too long.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (charCount(text) <= maxChars) return [text];
  const parts: string[] = [];
  let current = "";
  let length = 0;
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
    length = 0;
  };
  const add = (piece: string): boolean => {
    const n = charCount(piece);
    if (length + n > maxChars) return false;
    current += piece;
    length += n;
    return true;
  };
  const addOrStart = (piece: string) => {
    if (add(piece)) return;
    push();
    current = piece;
    length = charCount(piece);
  };
  for (const sentence of sentencesOf(tokenize(text))) {
    if (add(joined(sentence))) continue;
    push();
    if (add(joined(sentence))) continue;
    for (const word of wordsOf(sentence)) {
      if (add(joined(word))) continue;
      push();
      if (word[0]?.space || add(joined(word))) continue;
      // A single word longer than the limit: cut its text by code point.
      for (const t of word) {
        if (t.tag) addOrStart(t.text);
        else for (const ch of Array.from(t.text)) addOrStart(ch);
      }
    }
  }
  push();
  return parts;
}

/**
 * Tag openings with no closing `>` or `]`, such as `<break time="1s"` or
 * `[sighs`: a provider would read them aloud.
 */
export function unclosedMarkup(text: string): string[] {
  const rest = text.replace(/<[^<>]*>|\[[^[\]]*\]/gu, " ");
  return [...rest.matchAll(/<\/?[a-z][^\s<>]*|\[[\p{L}][^\s[\]]*/giu)].map((m) => m[0]);
}

/** SSML-looking tags and bracketed audio tags in a line. */
export function markupIn(text: string): { ssml: string[]; audioTags: string[] } {
  const ssml = [...text.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)].map((m) => m[0]);
  const audioTags = [...text.matchAll(/\[[\p{L}][\p{L} ,'-]{0,40}\]/gu)].map((m) => m[0]);
  return { ssml, audioTags };
}
