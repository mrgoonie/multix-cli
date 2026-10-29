/**
 * Local store for ratings, reviews and use-case notes. Private records live in
 * ~/.multix/catalog-notes.json (override with MULTIX_CATALOG_FILE); project
 * records in ./.multix/catalog-notes.json, so a team can commit them with the
 * project. Files are written atomically with mode 0600 under a lock file, so
 * concurrent commands do not lose each other's records. Every record is
 * validated and scrubbed (src/catalog/reviews.ts) when stored and again when
 * read back, since a project store arrives with the repository. For the same
 * reason a project review counts as tied to a run only when this machine's run
 * ledger holds that run and no other review references it, and a store file
 * over MAX_STORE_BYTES or LIMITS.records is read only in part.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type HistoryEntry, readHistory } from "../../agent/history-store.js";
import type { Review, ReviewScope, UseCaseNote } from "../../catalog/catalog-types.js";
import { LIMITS, type RunCheck, checkRuns, loadNote, loadReview } from "../../catalog/reviews.js";
import { resolvedModel } from "../../catalog/usage-aggregate.js";
import { ValidationError } from "../../core/errors.js";
import { defaultLogger } from "../../core/logger.js";

export const STORE_SCHEMA = "multix.catalog-notes/v1";

export interface CatalogStore {
  schema: typeof STORE_SCHEMA;
  reviews: Review[];
  notes: UseCaseNote[];
}

export function storeFile(scope: ReviewScope): string {
  if (scope === "project") return path.resolve(".multix", "catalog-notes.json");
  return process.env.MULTIX_CATALOG_FILE
    ? path.resolve(process.env.MULTIX_CATALOG_FILE)
    : path.join(os.homedir(), ".multix", "catalog-notes.json");
}

const empty = (): CatalogStore => ({ schema: STORE_SCHEMA, reviews: [], notes: [] });

/**
 * A repository could point its project store (or the .multix folder) at the
 * private store through a link; writing the project scope would then copy
 * private reviews into the repository. Links are refused for that scope.
 */
function refuseProjectLink(scope: ReviewScope, file: string): void {
  if (scope !== "project") return;
  for (const p of [file, path.dirname(file)]) {
    let linked = false;
    try {
      linked = fs.lstatSync(p).isSymbolicLink();
    } catch {
      // Missing: nothing to follow.
    }
    if (linked) {
      throw new ValidationError(`${p} is a symbolic link; the project store must be a plain file.`);
    }
  }
}

/**
 * Run check against this machine's run ledger: the run must exist with the
 * recorded time and have completed a real request of the offering, as
 * `--job` requires when a review is saved. The ledger is read and indexed
 * once, on first use.
 */
export function ledgerRunCheck(): RunCheck {
  let byId: Map<string, HistoryEntry> | undefined;
  return (usage, offering) => {
    byId ??= new Map(readHistory().map((e) => [e.id, e]));
    const e = byId.get(usage.history_id);
    if (!e || e.ts !== usage.ts || !e.ok || e.dry_run || e.estimate_only) return false;
    const model = resolvedModel(e);
    return model !== undefined && `${e.provider}:${model}` === offering;
  };
}

/** Largest store file read; a project store arrives with the repository and is read on every catalog command. */
export const MAX_STORE_BYTES = 8 * 1024 * 1024;

/**
 * How a store is read:
 * - `checked`: for use; run references are checked (`checkRuns`), and a file
 *   over the caps is skipped (or cut to the record limit) with a warning.
 * - `unchecked`: as `checked`, but run references are kept as stored, for a
 *   caller that checks the reviews of several stores together.
 * - `write`: for a read-modify-write; run references are kept as stored (they
 *   may be a teammate's runs) and a file over the caps is refused, since
 *   writing it back would lose records.
 */
export type ReadMode = "checked" | "unchecked" | "write";

/** Fail a write, or warn and go on with what fits, when a store is over a cap. */
function overCap(mode: ReadMode, message: string): void {
  if (mode === "write") throw new ValidationError(`${message}; trim it before writing to it.`);
  defaultLogger.warn(message);
}

export function readStore(scope: ReviewScope, mode: ReadMode = "checked"): CatalogStore {
  const file = storeFile(scope);
  refuseProjectLink(scope, file);
  let text: string;
  try {
    const bytes = fs.statSync(file).size;
    if (bytes > MAX_STORE_BYTES) {
      overCap(
        mode,
        `${file} is ${bytes} bytes, over the ${MAX_STORE_BYTES} a catalog store may hold; its records are skipped`,
      );
      return empty();
    }
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return empty();
  }
  let data: Partial<Record<keyof CatalogStore, unknown>>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ValidationError(`${file} is not valid JSON; fix or move it first.`);
  }
  let rawReviews = Array.isArray(data?.reviews) ? (data.reviews as unknown[]) : [];
  let rawNotes = Array.isArray(data?.notes) ? (data.notes as unknown[]) : [];
  if (rawReviews.length + rawNotes.length > LIMITS.records) {
    overCap(
      mode,
      `${file} holds ${rawReviews.length + rawNotes.length} records, over the ${LIMITS.records} a catalog store may hold; the rest are skipped`,
    );
    rawReviews = rawReviews.slice(0, LIMITS.records);
    rawNotes = rawNotes.slice(0, LIMITS.records - rawReviews.length);
  }
  const reviews = rawReviews.map((raw) => loadReview(raw, scope)).filter((r) => !!r);
  return {
    schema: STORE_SCHEMA,
    reviews: mode === "checked" ? checkRuns(reviews, ledgerRunCheck()) : reviews,
    notes: rawNotes.map((raw) => loadNote(raw, scope)).filter((n) => !!n),
  };
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run a read-modify-write of one scope's file under an exclusive lock file. */
export function withStoreLock<T>(scope: ReviewScope, fn: () => T): T {
  const file = storeFile(scope);
  refuseProjectLink(scope, file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS)
          fs.rmSync(lock, { force: true });
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) {
        throw new ValidationError(`${file} is locked by another multix command (${lock}).`);
      }
      pause(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function writeStore(scope: ReviewScope, store: CatalogStore): void {
  if (store.reviews.length + store.notes.length > LIMITS.records) {
    throw new ValidationError(`The ${scope} store holds at most ${LIMITS.records} records.`);
  }
  const file = storeFile(scope);
  refuseProjectLink(scope, file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Records of both scopes (project first missing is fine). Run references are
 * checked across both, so one run backs at most one review in either store.
 */
export function readAll(): CatalogStore {
  const out = unchecked();
  out.reviews = checkRuns(out.reviews, ledgerRunCheck());
  return out;
}

/** Records of both scopes with run references as stored. */
function unchecked(): CatalogStore {
  const out = empty();
  for (const scope of ["private", "project"] as const) {
    const s = readStore(scope, "unchecked");
    out.reviews.push(...s.reviews);
    out.notes.push(...s.notes);
  }
  return out;
}

export function newRecordId(prefix: "r" | "n", now = Date.now()): string {
  return `${prefix}_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Add a review, or update the one for the same offering and use case in the
 * same scope (one review per person per offering and use case): fields given
 * now replace the stored ones, the others are kept.
 */
export function upsertReview(
  fields: Omit<Review, "id" | "created_at" | "updated_at">,
  now = new Date(),
): Review {
  return withStoreLock(fields.scope, () => {
    const store = readStore(fields.scope, "write");
    const at = now.toISOString();
    const i = store.reviews.findIndex(
      (r) => r.offering === fields.offering && (r.use_case ?? "") === (fields.use_case ?? ""),
    );
    const prev = i >= 0 ? store.reviews[i] : undefined;
    if (fields.verified_usage) refuseSharedRun(fields.verified_usage.history_id, prev);
    const review: Review = {
      ...carriedOver(prev),
      ...fields,
      id: prev?.id ?? newRecordId("r", now.getTime()),
      created_at: prev?.created_at ?? at,
      updated_at: at,
    };
    if (prev) store.reviews[i] = review;
    else store.reviews.push(review);
    writeStore(fields.scope, store);
    return review;
  });
}

/**
 * A run backs one review: a second review referencing it reads as unverified
 * for both, so saving one is refused instead of storing a claim that never
 * counts. The review being updated (`prev`) does not count.
 */
function refuseSharedRun(historyId: string, prev: Review | undefined): void {
  const holder = unchecked().reviews.find(
    (r) =>
      r.verified_usage?.history_id === historyId && !(r.id === prev?.id && r.scope === prev.scope),
  );
  if (holder) {
    throw new ValidationError(
      `Run ${historyId} already backs ${holder.scope} review ${holder.id}; a run can back one review.`,
    );
  }
}

/**
 * The stored review an update starts from. A project review keeps its run
 * only when the run is in this machine's ledger, so editing someone else's
 * review does not pass their run off as backing the new text. Whether other
 * reviews reference the same run does not matter here: the owner's own edit
 * keeps the real run even while a copied reference makes it read unverified.
 */
function carriedOver(prev: Review | undefined): Partial<Review> | undefined {
  if (!prev?.verified_usage || prev.scope !== "project") return prev;
  if (ledgerRunCheck()(prev.verified_usage, prev.offering)) return prev;
  const { verified_usage: _unchecked, ...rest } = prev;
  return rest;
}

/** Throws when an offering and use case already hold the most notes allowed (`except` aside). */
function checkNoteLimit(store: CatalogStore, offering: string, useCase: string, except?: string) {
  const same = store.notes.filter(
    (n) => n.offering === offering && n.use_case === useCase && n.id !== except,
  );
  if (same.length >= LIMITS.notesPerUseCase) {
    throw new ValidationError(
      `At most ${LIMITS.notesPerUseCase} notes per offering and use case; edit or remove one.`,
    );
  }
}

export function addNote(
  fields: Omit<UseCaseNote, "id" | "created_at" | "updated_at">,
  now = new Date(),
): UseCaseNote {
  return withStoreLock(fields.scope, () => {
    const store = readStore(fields.scope, "write");
    checkNoteLimit(store, fields.offering, fields.use_case);
    const at = now.toISOString();
    const note: UseCaseNote = {
      ...fields,
      id: newRecordId("n", now.getTime()),
      created_at: at,
      updated_at: at,
    };
    store.notes.push(note);
    writeStore(fields.scope, store);
    return note;
  });
}

/** Find a record by id in either scope. */
export function locate(
  kind: "reviews" | "notes",
  id: string,
): { scope: ReviewScope; store: CatalogStore; index: number } {
  for (const scope of ["private", "project"] as const) {
    const store = readStore(scope, "unchecked");
    const index = (store[kind] as Array<{ id: string }>).findIndex((r) => r.id === id);
    if (index >= 0) return { scope, store, index };
  }
  throw new ValidationError(`No ${kind === "reviews" ? "review" : "note"} with id ${id}.`);
}

/** Change a located record under its scope's lock, re-reading the file first. */
function updateLocated<T>(
  kind: "reviews" | "notes",
  id: string,
  fn: (store: CatalogStore, index: number, scope: ReviewScope) => T,
): T {
  const { scope } = locate(kind, id);
  return withStoreLock(scope, () => {
    const store = readStore(scope, "write");
    const index = (store[kind] as Array<{ id: string }>).findIndex((r) => r.id === id);
    if (index < 0) {
      throw new ValidationError(`No ${kind === "reviews" ? "review" : "note"} with id ${id}.`);
    }
    const out = fn(store, index, scope);
    writeStore(scope, store);
    return out;
  });
}

export function replaceNote(
  id: string,
  fields: Omit<UseCaseNote, "id" | "created_at" | "updated_at">,
  now = new Date(),
): UseCaseNote {
  return updateLocated("notes", id, (store, index, scope) => {
    const prev = store.notes[index] as UseCaseNote;
    checkNoteLimit(store, fields.offering, fields.use_case, id);
    const note: UseCaseNote = {
      ...fields,
      scope,
      id,
      created_at: prev.created_at,
      updated_at: now.toISOString(),
    };
    store.notes[index] = note;
    return note;
  });
}

export function removeRecord(kind: "reviews" | "notes", id: string): ReviewScope {
  return updateLocated(kind, id, (store, index, scope) => {
    store[kind].splice(index, 1);
    return scope;
  });
}
