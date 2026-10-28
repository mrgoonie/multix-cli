/**
 * Local feedback store: round trips in a temp file, owner-only permissions,
 * one rating per offering, use case and scope (rating again replaces it), the
 * hourly burst limit, and refusal of a corrupt or foreign file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFeedback,
  deleteFeedback,
  feedbackFile,
  findFeedback,
  newFeedbackId,
  readFeedback,
  updateFeedback,
} from "../../../src/agent/feedback-store.js";
import { FEEDBACK_SCHEMA, type Feedback } from "../../../src/catalog/feedback-rules.js";
import { ValidationError } from "../../../src/core/errors.js";

const REF = "fal:bytedance/seedance-2.0/text-to-video";
let dir: string;
let file: string;

function entry(over: Partial<Feedback> = {}): Feedback {
  const now = new Date().toISOString();
  return {
    id: newFeedbackId(),
    kind: "rating",
    ref: REF,
    provider: "fal",
    model: "bytedance/seedance-2.0/text-to-video",
    scope: "private",
    score: 4,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function writeRaw(entries: Feedback[]): void {
  fs.writeFileSync(file, JSON.stringify({ schema: FEEDBACK_SCHEMA, entries }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-feedback-store-"));
  file = path.join(dir, "catalog-feedback.json");
  vi.stubEnv("MULTIX_CATALOG_FEEDBACK_FILE", file);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("feedback file location", () => {
  it("uses MULTIX_CATALOG_FEEDBACK_FILE, resolved to an absolute path", () => {
    vi.stubEnv("MULTIX_CATALOG_FEEDBACK_FILE", "relative/feedback.json");
    expect(feedbackFile()).toBe(path.resolve("relative/feedback.json"));
  });

  it("defaults to ~/.multix/catalog-feedback.json without the override", () => {
    vi.stubEnv("MULTIX_CATALOG_FEEDBACK_FILE", "");
    expect(feedbackFile()).toBe(path.join(os.homedir(), ".multix", "catalog-feedback.json"));
  });
});

describe("round trip", () => {
  it("reads an empty list when there is no file yet", () => {
    expect(fs.existsSync(file)).toBe(false);
    expect(readFeedback()).toEqual([]);
  });

  it("adds, finds, updates and deletes an entry", () => {
    const saved = addFeedback(entry({ text: "first" }));
    expect(readFeedback()).toEqual([saved]);
    expect(findFeedback(saved.id)).toEqual(saved);

    expect(updateFeedback({ ...saved, text: "edited" })).toBe(true);
    expect(findFeedback(saved.id)?.text).toBe("edited");

    expect(deleteFeedback(saved.id)).toBe(true);
    expect(readFeedback()).toEqual([]);
    expect(deleteFeedback(saved.id)).toBe(false);
  });

  it("replaces the other rating when an edit moves one onto its use case", () => {
    const a = addFeedback(entry({ use_case: "product-ugc", score: 2 }));
    const b = addFeedback(entry({ use_case: "explainer", score: 5 }));
    expect(updateFeedback({ ...b, use_case: "product-ugc" })).toBe(true);
    expect(readFeedback().map((e) => e.id)).toEqual([b.id]);
    expect(findFeedback(a.id)).toBeUndefined();
  });

  it("returns false when updating an entry that does not exist", () => {
    expect(updateFeedback(entry({ id: "fb_missing" }))).toBe(false);
    expect(findFeedback("fb_missing")).toBeUndefined();
  });

  it("writes the schema-tagged file with owner-only permissions", () => {
    addFeedback(entry());
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(body.schema).toBe(FEEDBACK_SCHEMA);
    expect(body.entries).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind after a write", () => {
    addFeedback(entry());
    expect(fs.readdirSync(dir).sort()).toEqual(["catalog-feedback.json"]);
  });
});

describe("one rating per offering, use case and scope", () => {
  it("replaces a rating for the same offering, use case, scope and project, keeping id and created_at", () => {
    const first = addFeedback(
      entry({ score: 3, use_case: "product-ugc", created_at: "2026-10-26T09:00:00.000Z" }),
    );
    const second = addFeedback(entry({ score: 5, use_case: "product-ugc" }));
    const all = readFeedback();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      score: 5,
      id: first.id,
      created_at: "2026-10-26T09:00:00.000Z",
    });
    expect(second.id).toBe(first.id);
  });

  it("keeps ratings for different use cases apart", () => {
    addFeedback(entry({ use_case: "product-ugc" }));
    addFeedback(entry({ use_case: "vietnamese-tts" }));
    expect(readFeedback()).toHaveLength(2);
  });

  it("keeps a private and a project rating for the same use case apart", () => {
    addFeedback(entry({ use_case: "product-ugc", scope: "private" }));
    addFeedback(entry({ use_case: "product-ugc", scope: "project", project: "repo-a" }));
    addFeedback(entry({ use_case: "product-ugc", scope: "project", project: "repo-b" }));
    expect(readFeedback()).toHaveLength(3);
  });

  it("never replaces a note or a review with a rating", () => {
    addFeedback(entry({ kind: "note", score: undefined, use_case: "product-ugc", verdict: "use" }));
    addFeedback(entry({ kind: "rating", score: 2, use_case: "product-ugc" }));
    expect(readFeedback().map((e) => e.kind)).toEqual(["note", "rating"]);
  });
});

describe("burst limit", () => {
  it("refuses the 61st new entry within an hour", () => {
    for (let i = 0; i < 60; i++) {
      addFeedback(entry({ kind: "note", score: undefined, use_case: `case-${i}`, verdict: "use" }));
    }
    expect(readFeedback()).toHaveLength(60);
    expect(() =>
      addFeedback(
        entry({ kind: "note", score: undefined, use_case: "one-too-many", verdict: "use" }),
      ),
    ).toThrow(/More than 60 feedback entries in the last hour/);
    expect(readFeedback()).toHaveLength(60);
  });

  it("does not count entries older than an hour", () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    writeRaw(
      Array.from({ length: 60 }, (_, i) =>
        entry({
          id: `fb_old_${i}`,
          kind: "note",
          score: undefined,
          use_case: `old-${i}`,
          verdict: "use",
          created_at: old,
          updated_at: old,
        }),
      ),
    );
    expect(() =>
      addFeedback(entry({ kind: "note", score: undefined, use_case: "fresh", verdict: "use" })),
    ).not.toThrow();
    expect(readFeedback()).toHaveLength(61);
  });

  it("does not refuse a rating that replaces an existing one during a burst", () => {
    addFeedback(entry({ score: 3, use_case: "product-ugc" }));
    for (let i = 0; i < 59; i++) {
      addFeedback(entry({ kind: "note", score: undefined, use_case: `case-${i}`, verdict: "use" }));
    }
    expect(readFeedback()).toHaveLength(60);
    expect(() => addFeedback(entry({ score: 5, use_case: "product-ugc" }))).not.toThrow();
    const ratings = readFeedback().filter((e) => e.kind === "rating");
    expect(ratings).toHaveLength(1);
    expect(ratings[0]?.score).toBe(5);
  });
});

describe("store limit", () => {
  it("refuses a new entry once the store holds 5000", () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    writeRaw(
      Array.from({ length: 5000 }, (_, i) =>
        entry({ id: `fb_full_${i}`, created_at: old, updated_at: old }),
      ),
    );
    expect(() => addFeedback(entry({ use_case: "one-more" }))).toThrow(/holds 5000 entries/);
  });
});

describe("corrupt or foreign files", () => {
  it("refuses a file that is not JSON, and names the file", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => readFeedback()).toThrow(ValidationError);
    expect(() => readFeedback()).toThrow(/is not valid JSON; fix or move it aside/);
    expect(() => addFeedback(entry())).toThrow(ValidationError);
  });

  it("refuses a file with another schema or without an entries list", () => {
    fs.writeFileSync(file, JSON.stringify({ schema: "multix.other/v1", entries: [] }));
    expect(() => readFeedback()).toThrow(/is not a multix.feedback\/v1 file/);
    fs.writeFileSync(file, JSON.stringify({ schema: FEEDBACK_SCHEMA, entries: "nope" }));
    expect(() => readFeedback()).toThrow(ValidationError);
  });

  it("does not overwrite a corrupt file when a write is refused", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => deleteFeedback("fb_any")).toThrow(ValidationError);
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });
});
