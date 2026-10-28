/**
 * Local store for catalogue ratings, reviews and use-case notes:
 * ~/.multix/catalog-feedback.json (override with MULTIX_CATALOG_FEEDBACK_FILE),
 * written atomically with owner-only permissions. Nothing here is sent
 * anywhere. One rating per offering, use case and scope: rating again replaces
 * it. A burst of new entries is refused to keep scripted spam out of the
 * summaries agents read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FEEDBACK_SCHEMA, type Feedback } from "../catalog/feedback-rules.js";
import { ValidationError } from "../core/errors.js";

const MAX_ENTRIES = 5000;
const BURST_WINDOW_MS = 3600_000;
const BURST_MAX = 60;

interface FeedbackFile {
  schema: typeof FEEDBACK_SCHEMA;
  entries: Feedback[];
}

export function feedbackFile(): string {
  return process.env.MULTIX_CATALOG_FEEDBACK_FILE
    ? path.resolve(process.env.MULTIX_CATALOG_FEEDBACK_FILE)
    : path.join(os.homedir(), ".multix", "catalog-feedback.json");
}

export function readFeedback(): Feedback[] {
  let text: string;
  try {
    text = fs.readFileSync(feedbackFile(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(`${feedbackFile()} is not valid JSON; fix or move it aside`);
  }
  const file = parsed as Partial<FeedbackFile>;
  if (file.schema !== FEEDBACK_SCHEMA || !Array.isArray(file.entries)) {
    throw new ValidationError(`${feedbackFile()} is not a ${FEEDBACK_SCHEMA} file`);
  }
  return file.entries;
}

function writeFeedback(entries: Feedback[]): void {
  const file = feedbackFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: FeedbackFile = { schema: FEEDBACK_SCHEMA, entries };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function newFeedbackId(now = Date.now()): string {
  return `fb_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Same offering, use case, scope and project: a second rating replaces the first. */
function sameRating(a: Feedback, b: Feedback): boolean {
  return (
    a.kind === "rating" &&
    b.kind === "rating" &&
    a.ref === b.ref &&
    (a.use_case ?? "") === (b.use_case ?? "") &&
    a.scope === b.scope &&
    (a.project ?? "") === (b.project ?? "")
  );
}

/** Add an entry (or replace the matching rating); returns the stored entry. */
export function addFeedback(entry: Feedback, now = Date.now()): Feedback {
  const entries = readFeedback();
  const existing = entries.findIndex((e) => sameRating(e, entry));
  if (existing >= 0) {
    const prev = entries[existing] as Feedback;
    const replaced = { ...entry, id: prev.id, created_at: prev.created_at };
    entries[existing] = replaced;
    writeFeedback(entries);
    return replaced;
  }
  const recent = entries.filter((e) => now - Date.parse(e.created_at) < BURST_WINDOW_MS).length;
  if (recent >= BURST_MAX) {
    throw new ValidationError(
      `More than ${BURST_MAX} feedback entries in the last hour; wait before adding more`,
    );
  }
  if (entries.length >= MAX_ENTRIES) {
    throw new ValidationError(
      `The feedback store holds ${MAX_ENTRIES} entries; delete some with \`multix catalog delete <id>\``,
    );
  }
  entries.push(entry);
  writeFeedback(entries);
  return entry;
}

export function findFeedback(id: string, entries = readFeedback()): Feedback | undefined {
  return entries.find((e) => e.id === id);
}

/**
 * Replace an entry by id; returns false when there is none. A rating edited onto
 * a use case that already has one replaces that rating, as a new rating would.
 */
export function updateFeedback(updated: Feedback): boolean {
  const entries = readFeedback();
  const i = entries.findIndex((e) => e.id === updated.id);
  if (i < 0) return false;
  entries[i] = updated;
  writeFeedback(entries.filter((e) => e.id === updated.id || !sameRating(e, updated)));
  return true;
}

export function deleteFeedback(id: string): boolean {
  const entries = readFeedback();
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  writeFeedback(kept);
  return true;
}
