/**
 * Local store for ratings, reviews and use-case notes. Private records live in
 * ~/.multix/catalog-notes.json (override with MULTIX_CATALOG_FILE); project
 * records in ./.multix/catalog-notes.json, so a team can commit them with the
 * project. Files are written atomically with mode 0600 under a lock file, so
 * concurrent commands do not lose each other's records. Every record is
 * validated and scrubbed (src/catalog/reviews.ts) when stored and again when
 * read back, since a project store arrives with the repository.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Review, ReviewScope, UseCaseNote } from "../../catalog/catalog-types.js";
import { LIMITS, loadNote, loadReview } from "../../catalog/reviews.js";
import { ValidationError } from "../../core/errors.js";

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

export function readStore(scope: ReviewScope): CatalogStore {
  const file = storeFile(scope);
  refuseProjectLink(scope, file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return empty();
  }
  let data: Partial<Record<keyof CatalogStore, unknown>>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ValidationError(`${file} is not valid JSON; fix or move it first.`);
  }
  const each = <T>(v: unknown, load: (raw: unknown, scope: ReviewScope) => T | undefined) =>
    (Array.isArray(v) ? v : []).map((raw) => load(raw, scope)).filter((r): r is T => !!r);
  return {
    schema: STORE_SCHEMA,
    reviews: each(data?.reviews, loadReview),
    notes: each(data?.notes, loadNote),
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

/** Records of both scopes (project first missing is fine). */
export function readAll(): CatalogStore {
  const out = empty();
  for (const scope of ["private", "project"] as const) {
    const s = readStore(scope);
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
    const store = readStore(fields.scope);
    const at = now.toISOString();
    const i = store.reviews.findIndex(
      (r) => r.offering === fields.offering && (r.use_case ?? "") === (fields.use_case ?? ""),
    );
    const prev = i >= 0 ? store.reviews[i] : undefined;
    const review: Review = {
      ...prev,
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
    const store = readStore(fields.scope);
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
    const store = readStore(scope);
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
    const store = readStore(scope);
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
