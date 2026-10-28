/**
 * Local store for ratings, reviews and use-case notes. Private records live in
 * ~/.multix/catalog-notes.json (override with MULTIX_CATALOG_FILE); project
 * records in ./.multix/catalog-notes.json, so a team can commit them with the
 * project. Files are written atomically with mode 0600. Validation and
 * scrubbing happen in src/catalog/reviews.ts before anything is stored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Review, ReviewScope, UseCaseNote } from "../../catalog/catalog-types.js";
import { LIMITS } from "../../catalog/reviews.js";
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

export function readStore(scope: ReviewScope): CatalogStore {
  let text: string;
  try {
    text = fs.readFileSync(storeFile(scope), "utf8");
  } catch {
    return empty();
  }
  try {
    const data = JSON.parse(text) as Partial<CatalogStore>;
    return {
      schema: STORE_SCHEMA,
      reviews: Array.isArray(data.reviews) ? data.reviews : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
    };
  } catch {
    throw new ValidationError(`${storeFile(scope)} is not valid JSON; fix or move it first.`);
  }
}

export function writeStore(scope: ReviewScope, store: CatalogStore): void {
  if (store.reviews.length + store.notes.length > LIMITS.records) {
    throw new ValidationError(`The ${scope} store holds at most ${LIMITS.records} records.`);
  }
  const file = storeFile(scope);
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
}

export function addNote(
  fields: Omit<UseCaseNote, "id" | "created_at" | "updated_at">,
  now = new Date(),
): UseCaseNote {
  const store = readStore(fields.scope);
  const same = store.notes.filter(
    (n) => n.offering === fields.offering && n.use_case === fields.use_case,
  );
  if (same.length >= LIMITS.notesPerUseCase) {
    throw new ValidationError(
      `At most ${LIMITS.notesPerUseCase} notes per offering and use case; edit or remove one.`,
    );
  }
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

export function replaceNote(
  id: string,
  fields: Omit<UseCaseNote, "id" | "created_at" | "updated_at">,
  now = new Date(),
): UseCaseNote {
  const { scope, store, index } = locate("notes", id);
  const prev = store.notes[index] as UseCaseNote;
  const note: UseCaseNote = {
    ...fields,
    scope,
    id,
    created_at: prev.created_at,
    updated_at: now.toISOString(),
  };
  store.notes[index] = note;
  writeStore(scope, store);
  return note;
}

export function removeRecord(kind: "reviews" | "notes", id: string): ReviewScope {
  const { scope, store, index } = locate(kind, id);
  store[kind].splice(index, 1);
  writeStore(scope, store);
  return scope;
}
