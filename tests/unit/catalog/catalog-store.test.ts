/**
 * The local ratings, reviews and notes store: merge rules, per-use-case note
 * limit, record lookup and removal, and the file the records are written to.
 * Every test works in a temporary directory and restores the environment.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UseCaseNote } from "../../../src/catalog/catalog-types.js";
import { LIMITS, cleanNote, cleanReview } from "../../../src/catalog/reviews.js";
import {
  STORE_SCHEMA,
  addNote,
  locate,
  readAll,
  readStore,
  removeRecord,
  replaceNote,
  storeFile,
  upsertReview,
  writeStore,
} from "../../../src/commands/agent/catalog-store.js";
import { ValidationError } from "../../../src/core/errors.js";

const OFFERING = "fal:bytedance/seedance-2.5/text-to-video";
const T1 = new Date("2026-10-27T10:00:00.000Z");
const T2 = new Date("2026-10-28T10:00:00.000Z");

let dir: string;
let file: string;
let previous: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-catalog-store-"));
  file = path.join(dir, "catalog-notes.json");
  previous = process.env.MULTIX_CATALOG_FILE;
  process.env.MULTIX_CATALOG_FILE = file;
});

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "MULTIX_CATALOG_FILE");
  else process.env.MULTIX_CATALOG_FILE = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

const ratingFields = (score: number, use_case?: string) =>
  cleanReview({ offering: OFFERING, scope: "private", score, ...(use_case ? { use_case } : {}) });

const noteFields = (use_case = "product-ugc") =>
  cleanNote({ offering: OFFERING, use_case, verdict: "recommended", scope: "private" });

describe("storeFile", () => {
  it("uses MULTIX_CATALOG_FILE for private records", () => {
    expect(storeFile("private")).toBe(file);
  });

  it("keeps project records in ./.multix of the working directory", () => {
    expect(storeFile("project")).toBe(path.resolve(".multix", "catalog-notes.json"));
  });

  it("reads an empty store when the file does not exist yet", () => {
    expect(readStore("private")).toEqual({ schema: STORE_SCHEMA, reviews: [], notes: [] });
  });

  it("refuses a file that is not JSON, without overwriting it", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => readStore("private")).toThrow(ValidationError);
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });
});

describe("upsertReview", () => {
  it("adds a review, then a rating for the same offering and use case updates it in place", () => {
    const first = upsertReview(ratingFields(4, "product-ugc"), T1);
    const second = upsertReview(ratingFields(5, "product-ugc"), T2);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      score: 5,
      created_at: T1.toISOString(),
      updated_at: T2.toISOString(),
    });
    expect(readStore("private").reviews).toHaveLength(1);
  });

  it("keeps the rating when a text review for the same use case follows, and adds the text", () => {
    const rated = upsertReview(ratingFields(4, "product-ugc"), T1);
    const reviewed = upsertReview(
      cleanReview({
        offering: OFFERING,
        scope: "private",
        use_case: "product-ugc",
        text: "Smooth motion",
      }),
      T2,
    );
    expect(reviewed).toMatchObject({ id: rated.id, score: 4, text: "Smooth motion" });
  });

  it("keeps a separate review for each use case of the same offering", () => {
    upsertReview(ratingFields(4, "product-ugc"), T1);
    upsertReview(ratingFields(2, "music-video"), T1);
    expect(
      readStore("private")
        .reviews.map((r) => r.use_case)
        .sort(),
    ).toEqual(["music-video", "product-ugc"]);
  });

  it("writes the store as JSON the next read returns unchanged", () => {
    const saved = upsertReview(ratingFields(3), T1);
    expect(readStore("private").reviews).toEqual([saved]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ schema: STORE_SCHEMA });
  });

  it("creates the store's directory when it is missing", () => {
    const nested = path.join(dir, "deep", "nest", "notes.json");
    process.env.MULTIX_CATALOG_FILE = nested;
    upsertReview(ratingFields(3), T1);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("writes the file readable only by its owner", () => {
    upsertReview(ratingFields(3), T1);
    if (process.platform === "win32") return;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("addNote", () => {
  it("allows up to the per-use-case limit of notes for one offering and use case", () => {
    for (let i = 0; i < LIMITS.notesPerUseCase; i++)
      addNote(noteFields(), new Date(T1.getTime() + i));
    expect(readStore("private").notes).toHaveLength(LIMITS.notesPerUseCase);
  });

  it("refuses the note after the limit, and says how to proceed", () => {
    for (let i = 0; i < LIMITS.notesPerUseCase; i++)
      addNote(noteFields(), new Date(T1.getTime() + i));
    expect(() => addNote(noteFields(), T2)).toThrow(
      `At most ${LIMITS.notesPerUseCase} notes per offering and use case; edit or remove one.`,
    );
  });

  it("does not count notes of another use case against the limit", () => {
    for (let i = 0; i < LIMITS.notesPerUseCase; i++)
      addNote(noteFields(), new Date(T1.getTime() + i));
    expect(() => addNote(noteFields("music-video"), T2)).not.toThrow();
  });

  it("gives each note its own id and dates it", () => {
    const a = addNote(noteFields(), T1);
    const b = addNote(noteFields(), T1);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ created_at: T1.toISOString(), updated_at: T1.toISOString() });
  });
});

describe("locate, replaceNote and removeRecord", () => {
  it("finds a record by id and says which scope holds it", () => {
    const review = upsertReview(ratingFields(4), T1);
    expect(locate("reviews", review.id)).toMatchObject({ scope: "private", index: 0 });
  });

  it("refuses an id that is not in any scope", () => {
    expect(() => locate("notes", "n_missing")).toThrow(
      new ValidationError("No note with id n_missing."),
    );
    expect(() => locate("reviews", "r_missing")).toThrow(
      new ValidationError("No review with id r_missing."),
    );
  });

  it("replaces a note's fields but keeps its id and creation date", () => {
    const note = addNote(noteFields(), T1);
    const replaced: UseCaseNote = replaceNote(
      note.id,
      cleanNote({
        offering: OFFERING,
        use_case: "product-ugc",
        verdict: "avoid",
        scope: "private",
        text: "Too slow",
      }),
      T2,
    );
    expect(replaced).toMatchObject({
      id: note.id,
      verdict: "avoid",
      text: "Too slow",
      created_at: T1.toISOString(),
      updated_at: T2.toISOString(),
      scope: "private",
    });
    expect(readStore("private").notes).toHaveLength(1);
  });

  it("removes a record once, and a second removal refuses", () => {
    const review = upsertReview(ratingFields(4), T1);
    expect(removeRecord("reviews", review.id)).toBe("private");
    expect(readStore("private").reviews).toEqual([]);
    expect(() => removeRecord("reviews", review.id)).toThrow(ValidationError);
  });

  it("removes one note and leaves the others", () => {
    const keep = addNote(noteFields(), T1);
    const drop = addNote(noteFields("music-video"), T1);
    removeRecord("notes", drop.id);
    expect(readStore("private").notes.map((n) => n.id)).toEqual([keep.id]);
  });
});

describe("store size", () => {
  it("refuses to write more records than one store holds", () => {
    const notes = Array.from({ length: LIMITS.records + 1 }, (_, i) => ({
      ...noteFields(),
      id: `n_${i}`,
      created_at: "",
      updated_at: "",
    }));
    expect(() => writeStore("private", { schema: STORE_SCHEMA, reviews: [], notes })).toThrow(
      `The private store holds at most ${LIMITS.records} records.`,
    );
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("readAll", () => {
  it("returns the private records", () => {
    upsertReview(ratingFields(4), T1);
    addNote(noteFields(), T1);
    const all = readAll();
    expect(all.reviews).toHaveLength(1);
    expect(all.notes).toHaveLength(1);
  });
});
