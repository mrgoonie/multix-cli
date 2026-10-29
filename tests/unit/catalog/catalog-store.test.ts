/**
 * The local ratings, reviews and notes store: merge rules, per-use-case note
 * limit, record lookup and removal, and the file the records are written to.
 * Every test works in a temporary directory and restores the environment.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCaseNote } from "../../../src/catalog/catalog-types.js";
import { LIMITS, cleanNote, cleanReview } from "../../../src/catalog/reviews.js";
import {
  MAX_STORE_BYTES,
  STORE_SCHEMA,
  addNote,
  locate,
  readAll,
  readStore,
  removeRecord,
  replaceNote,
  storeFile,
  upsertReview,
  withStoreLock,
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

describe("records read back from a store file", () => {
  const stamp = { created_at: "2026-10-27T10:00:00.000Z", updated_at: "2026-10-27T10:00:00.000Z" };

  it("scrubs text, keeps valid records and drops malformed ones", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        reviews: [
          {
            id: "r_ok1",
            offering: OFFERING,
            scope: "project",
            score: 4,
            text: "good\u001b[2Jclear me@corp.example",
            ...stamp,
          },
          { id: "r_bad1", offering: OFFERING, scope: "private", score: "5", ...stamp },
          { id: "r_bad2", offering: OFFERING, scope: "private", score: 3319, ...stamp },
          {
            id: "r_bad3",
            offering: OFFERING,
            scope: "private",
            aspects: { quality: "5" },
            ...stamp,
          },
          { id: "../x", offering: OFFERING, scope: "private", score: 3, ...stamp },
          "not a record",
        ],
        notes: [
          {
            id: "n_ok1",
            offering: OFFERING,
            use_case: "Product UGC",
            verdict: "avoid",
            scope: "private",
            ...stamp,
          },
          {
            id: "n_bad1",
            offering: OFFERING,
            use_case: "ugc",
            verdict: "great",
            scope: "private",
            ...stamp,
          },
        ],
      }),
    );
    const store = readStore("private");
    expect(store.reviews).toEqual([
      {
        id: "r_ok1",
        offering: OFFERING,
        scope: "private",
        score: 4,
        text: "good[2Jclear [email]",
        ...stamp,
      },
    ]);
    expect(store.notes.map((n) => [n.id, n.use_case, n.scope])).toEqual([
      ["n_ok1", "product-ugc", "private"],
    ]);
  });

  it("refuses a project store that is a symbolic link", () => {
    const cwd = process.cwd();
    const project = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.mkdirSync(path.join(project, ".multix"));
    fs.writeFileSync(file, JSON.stringify({ reviews: [], notes: [] }));
    fs.symlinkSync(file, path.join(project, ".multix", "catalog-notes.json"));
    process.chdir(project);
    try {
      expect(() => readStore("project")).toThrow(/symbolic link/);
      expect(() =>
        upsertReview(cleanReview({ offering: OFFERING, scope: "project", score: 4 })),
      ).toThrow(/symbolic link/);
    } finally {
      process.chdir(cwd);
    }
    expect(JSON.parse(fs.readFileSync(file, "utf8")).reviews).toEqual([]);
  });

  it("waits for another command's lock and reports one that is held too long", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "");
    const started = Date.now();
    expect(() => withStoreLock("private", () => 1)).toThrow(/locked by another multix command/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    fs.rmSync(`${file}.lock`);
    expect(withStoreLock("private", () => 2)).toBe(2);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  }, 10_000);

  it("keeps the per-use-case note limit when an edit moves a note to another use case", () => {
    for (let i = 0; i < LIMITS.notesPerUseCase; i++) {
      addNote(
        cleanNote({ offering: OFFERING, use_case: "ugc", verdict: "mixed", scope: "private" }),
      );
    }
    const other = addNote(
      cleanNote({ offering: OFFERING, use_case: "ads", verdict: "mixed", scope: "private" }),
    );
    expect(() =>
      replaceNote(
        other.id,
        cleanNote({ offering: OFFERING, use_case: "ugc", verdict: "mixed", scope: "private" }),
      ),
    ).toThrow(ValidationError);
  });
});

describe("project reviews tied to a run", () => {
  const stamp = { created_at: "2026-10-27T10:00:00.000Z", updated_at: "2026-10-27T10:00:00.000Z" };
  const run = { history_id: "h_real1", ts: "2026-10-27T09:00:00.000Z" };
  const ledgerEntry = {
    v: 1,
    id: run.history_id,
    ts: run.ts,
    duration_ms: 4000,
    cwd: "/x",
    version: "0.0.0",
    command: "fal video",
    provider: "fal",
    model_resolved: "bytedance/seedance-2.5/text-to-video",
    argv: ["fal", "video"],
    ok: true,
    exit_code: 0,
  };
  const forged = {
    id: "r_forged1",
    offering: OFFERING,
    use_case: "ads",
    score: 5,
    verified_usage: { history_id: "h_doesnotexist", ts: run.ts },
    ...stamp,
  };
  const genuine = { id: "r_genuine1", offering: OFFERING, score: 4, verified_usage: run, ...stamp };

  let cwd: string;
  let projectFile: string;
  let previousHistory: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    const project = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.mkdirSync(path.join(project, ".multix"));
    projectFile = path.join(project, ".multix", "catalog-notes.json");
    previousHistory = process.env.MULTIX_HISTORY_FILE;
    process.env.MULTIX_HISTORY_FILE = path.join(dir, "history.jsonl");
    fs.writeFileSync(process.env.MULTIX_HISTORY_FILE, `${JSON.stringify(ledgerEntry)}\n`);
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(cwd);
    if (previousHistory === undefined) Reflect.deleteProperty(process.env, "MULTIX_HISTORY_FILE");
    else process.env.MULTIX_HISTORY_FILE = previousHistory;
  });

  const writeProject = (...reviews: unknown[]) =>
    fs.writeFileSync(projectFile, JSON.stringify({ reviews, notes: [] }));

  it("reads a run that is not in this machine's ledger as unverified", () => {
    writeProject(forged, genuine);
    const reviews = readAll().reviews;
    expect(reviews.find((r) => r.id === "r_forged1")?.verified_usage).toBeUndefined();
    expect(reviews.find((r) => r.id === "r_genuine1")?.verified_usage).toEqual(run);
  });

  it("verifies neither review when a copy of the run is placed before the real one", () => {
    writeProject({ ...genuine, id: "r_copy1", use_case: "ads" }, genuine);
    const reviews = readAll().reviews;
    expect(reviews.find((r) => r.id === "r_copy1")?.verified_usage).toBeUndefined();
    expect(reviews.find((r) => r.id === "r_genuine1")?.verified_usage).toBeUndefined();
  });

  it("does not let a malformed record that is dropped claim the run", () => {
    writeProject({ ...genuine, id: "r_bad1", use_case: "ads", score: 99 }, genuine);
    const reviews = readAll().reviews;
    expect(reviews.map((r) => r.id)).toEqual(["r_genuine1"]);
    expect(reviews[0]?.verified_usage).toEqual(run);
  });

  it("keeps the owner's run in the file when the owner edits the review a copy shadows", () => {
    writeProject({ ...genuine, id: "r_copy1", use_case: "ads" }, genuine);
    const edited = upsertReview(
      cleanReview({ offering: OFFERING, scope: "project", text: "Still good" }),
      T2,
    );
    expect(edited).toMatchObject({ id: "r_genuine1", verified_usage: run });
    const saved = JSON.parse(fs.readFileSync(projectFile, "utf8")).reviews;
    expect(saved.find((r: { id: string }) => r.id === "r_genuine1").verified_usage).toEqual(run);
  });

  it("verifies neither review when a private and a project review share a run", () => {
    writeProject(genuine);
    fs.writeFileSync(file, JSON.stringify({ reviews: [{ ...genuine, id: "r_mine1" }], notes: [] }));
    expect(readAll().reviews.map((r) => r.verified_usage)).toEqual([undefined, undefined]);
  });

  it("refuses to save a review with a run that already backs another review", () => {
    writeProject(genuine);
    const fields = cleanReview({
      offering: OFFERING,
      scope: "private",
      use_case: "ads",
      score: 4,
      verified_usage: run,
    });
    expect(() => upsertReview(fields, T2)).toThrow(
      new ValidationError(
        "Run h_real1 already backs project review r_genuine1; a run can back one review.",
      ),
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("lets the review that holds a run be saved again with it", () => {
    writeProject(genuine);
    const fields = cleanReview({
      offering: OFFERING,
      scope: "project",
      score: 5,
      verified_usage: run,
    });
    expect(upsertReview(fields, T2)).toMatchObject({ id: "r_genuine1", verified_usage: run });
  });

  it("does not verify a ledger run of another offering, a failed run or another time", () => {
    for (const entry of [
      { ...ledgerEntry, model_resolved: "other/model" },
      { ...ledgerEntry, ok: false },
      { ...ledgerEntry, dry_run: true },
      { ...ledgerEntry, ts: "2026-10-27T09:30:00.000Z" },
    ]) {
      fs.writeFileSync(process.env.MULTIX_HISTORY_FILE as string, `${JSON.stringify(entry)}\n`);
      writeProject(genuine);
      expect(readStore("project").reviews[0]?.verified_usage).toBeUndefined();
    }
  });

  it("keeps a teammate's run reference in the file when another record is written", () => {
    writeProject(forged);
    upsertReview(cleanReview({ offering: OFFERING, scope: "project", score: 3 }), T2);
    const saved = JSON.parse(fs.readFileSync(projectFile, "utf8")).reviews;
    expect(saved.find((r: { id: string }) => r.id === "r_forged1").verified_usage).toEqual(
      forged.verified_usage,
    );
  });

  it("drops an unconfirmed run when the review it backs is edited here", () => {
    writeProject(forged);
    const edited = upsertReview(
      cleanReview({ offering: OFFERING, scope: "project", use_case: "ads", text: "Changed" }),
      T2,
    );
    expect(edited).toMatchObject({ id: "r_forged1", score: 5, text: "Changed" });
    expect(edited.verified_usage).toBeUndefined();
  });

  it("keeps a confirmed run when the review it backs is edited here", () => {
    writeProject(genuine);
    const edited = upsertReview(
      cleanReview({ offering: OFFERING, scope: "project", text: "Still good" }),
      T2,
    );
    expect(edited.verified_usage).toEqual(run);
  });
});

describe("store size caps", () => {
  const stamp = { created_at: "2026-10-27T10:00:00.000Z", updated_at: "2026-10-27T10:00:00.000Z" };
  const note = (i: number) => ({
    id: `n_${i}`,
    offering: OFFERING,
    use_case: "ugc",
    verdict: "mixed",
    ...stamp,
  });
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("skips a store file over the size cap with a warning, and refuses to write to it", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ reviews: [], notes: [note(1)], pad: "x".repeat(MAX_STORE_BYTES) }),
    );
    expect(readStore("private").notes).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/its records are skipped/);
    expect(() => addNote(noteFields(), T1)).toThrow(/trim it before writing to it/);
  });

  it("reads only the records up to the record cap, with a warning, and refuses to write", () => {
    const notes = Array.from({ length: LIMITS.records + 3 }, (_, i) => note(i));
    fs.writeFileSync(file, JSON.stringify({ reviews: [], notes }));
    expect(readStore("private").notes).toHaveLength(LIMITS.records);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/the rest are skipped/);
    expect(() => addNote(noteFields("ads"), T1)).toThrow(ValidationError);
  });
});
