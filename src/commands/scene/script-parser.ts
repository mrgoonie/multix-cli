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

/** True when a run has spoken text, not only tags, spaces and punctuation. */
const spoken = (run: Token[]) => run.some((t) => !t.tag && /[\p{L}\p{N}]/u.test(t.text));
/** Index of the last run with spoken text, or -1. */
const lastSpokenIn = (runs: Token[][]) => {
  let i = runs.length - 1;
  while (i >= 0 && !spoken(runs[i] ?? [])) i--;
  return i;
};

/**
 * Keep runs with no spoken text next to runs that have some, so a split
 * never sends them as a request of their own. Bare punctuation (`?` in
 * French spacing, `...`) joins the run before it; a tag, or punctuation with
 * nothing spoken before it, joins the next spoken run, or at the end the
 * last one before it.
 */
function attachTags(runs: Token[][]): Token[][] {
  const out: Token[][] = [];
  let pending: Token[] = [];
  const joinBack = (tokens: Token[]) => {
    const tail = out.splice(lastSpokenIn(out)).flat();
    out.push([...tail, ...tokens]);
  };
  for (const run of runs) {
    const bare = !spoken(run) && !run[0]?.space;
    if (!pending.length && !bare) {
      out.push(run);
      continue;
    }
    if (!pending.length && !run.some((t) => t.tag) && lastSpokenIn(out) >= 0) {
      joinBack(run);
      continue;
    }
    pending.push(...run);
    if (spoken(run)) {
      out.push(pending);
      pending = [];
    }
  }
  if (!pending.length) return out;
  if (lastSpokenIn(out) < 0) return [...out, pending];
  joinBack(pending);
  return out;
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
  return attachTags(sentences);
}

/**
 * Words and the spaces between them, each as its own token run; a tag goes
 * with the word after it, or the word before it at the end of a sentence.
 */
function wordsOf(sentence: Token[]): Token[][] {
  const words: Token[][] = [];
  for (const t of sentence) {
    const last = words.at(-1);
    if (t.space || !last || last[0]?.space) words.push([t]);
    else last.push(t);
  }
  return attachTags(words);
}

const joined = (tokens: Token[]) => tokens.map((t) => t.text).join("");

/** True when `text` has words to speak once its tags are removed. */
export function hasSpokenText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/<[^<>]*>|\[[^[\]]*\]/gu, ""));
}

const TAG_BODY = "\u0001";
/** `s` with each tag's characters after the first replaced by TAG_BODY, same length. */
const maskTags = (s: string) =>
  s.replace(/<[^<>]*>|\[[^[\]]*\]/gu, (m) => `\u0002${TAG_BODY.repeat(m.length - 1)}`);

/**
 * Give each part with no spoken text (tags or punctuation alone) words to go
 * with: join it to the part before or after it when the two fit the limit,
 * or else move the end of the part before into it. Parts are trimmed
 * slices of `text` in order, so a join takes the exact text between them.
 */
function joinBareParts(text: string, parts: string[], maxChars: number): string[] {
  let at = 0;
  const spans = parts.map((p) => {
    const start = text.indexOf(p, at);
    at = start + p.length;
    return [start, at] as [number, number];
  });
  const slice = ([a, b]: [number, number]) => text.slice(a, b);
  const fits = (span: [number, number]) => charCount(slice(span)) <= maxChars;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as [number, number];
    if (hasSpokenText(slice(span))) continue;
    const before = spans[i - 1];
    const after = spans[i + 1];
    if (before && fits([before[0], span[1]])) {
      spans.splice(i - 1, 2, [before[0], span[1]]);
      i -= 2;
    } else if (after && fits([span[0], after[1]])) {
      spans.splice(i, 2, [span[0], after[1]]);
      i -= 1;
    } else if (before) {
      // The last word, or for a part cut by code point (no space in it), its
      // last spoken character; never from inside a tag.
      const prev = slice(before);
      const masked = maskTags(prev);
      // The last space after which spoken text remains, so a bare "?" or tag
      // at the end of `prev` moves together with the word before it.
      let space = -1;
      for (let k = masked.length - 1; k >= 0; k--) {
        if (/\s/u.test(masked[k] ?? "") && hasSpokenText(prev.slice(k + 1))) {
          space = k;
          break;
        }
      }
      let from = space + 1;
      if (space < 0) {
        from = -1;
        for (let k = prev.length - 1; k > 0; k--) {
          if (masked[k] === TAG_BODY || /[\uDC00-\uDFFF]/u.test(masked[k] ?? "")) continue;
          if (/[\p{L}\p{N}]/u.test(masked.slice(k))) {
            from = k;
            break;
          }
        }
        if (from < 0) continue;
      }
      const kept: [number, number] = [before[0], before[0] + prev.slice(0, from).trimEnd().length];
      const moved: [number, number] = [before[0] + from, span[1]];
      if (!fits(moved) || !hasSpokenText(slice(kept))) continue;
      spans.splice(i - 1, 2, kept, moved);
    }
  }
  return spans.map(slice);
}

/**
 * Split `text` into parts of at most `maxChars` code points, at sentence,
 * then word boundaries, keeping each tag with a neighbouring word. Tags are
 * never cut: only when a tag and its word together exceed the limit can a
 * part be left with no spoken text, which partErrors rejects.
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
  const start = (piece: string) => {
    push();
    current = piece;
    length = charCount(piece);
  };
  // A new part never starts with bare punctuation: the last spoken character
  // of the current part moves over with it, unless it is the only one.
  const startText = (piece: string) => {
    const kept = Array.from(current);
    const carry =
      !hasSpokenText(piece) &&
      hasSpokenText(kept.at(-1) ?? "") &&
      hasSpokenText(kept.slice(0, -1).join(""));
    const moved = carry ? (kept.pop() ?? "") : "";
    current = kept.join("");
    start(moved + piece);
  };
  // Cut text by code point, continuing the current part.
  const cut = (piece: string) => {
    for (const ch of Array.from(piece)) if (!add(ch)) startText(ch);
  };
  for (const sentence of sentencesOf(tokenize(text))) {
    if (add(joined(sentence))) continue;
    push();
    if (add(joined(sentence))) continue;
    for (const word of wordsOf(sentence)) {
      if (add(joined(word))) continue;
      if (word[0]?.space) {
        push();
        continue;
      }
      if (charCount(joined(word)) <= maxChars) {
        start(joined(word));
        continue;
      }
      // A word (with its tags) longer than the limit: lay out its tokens in
      // turn, cutting a token's text in place when it alone is too long.
      for (const t of word) {
        if (add(t.text)) continue;
        if (t.space) push();
        else if (t.tag) start(t.text);
        // Text glued to a part of only tags continues that part (unspaced
        // scripts such as Japanese), so the tags are not left alone.
        else if (charCount(t.text) > maxChars || (!hasSpokenText(current) && !/\s$/u.test(current)))
          cut(t.text);
        else startText(t.text);
      }
    }
  }
  push();
  return joinBareParts(text, parts, maxChars);
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
