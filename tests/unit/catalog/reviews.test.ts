/**
 * Ratings and reviews: scrubbing of free text, bounds, scope and score rules,
 * and the slug and offering-reference parsing the CLI relies on.
 */

import { describe, expect, it } from "vitest";
import type { Review } from "../../../src/catalog/catalog-types.js";
import {
  LIMITS,
  cleanNote,
  cleanReview,
  parseAspects,
  parseOffering,
  parseScope,
  parseScore,
  scrubText,
  slug,
  summarizeReviews,
} from "../../../src/catalog/reviews.js";
import { ValidationError } from "../../../src/core/errors.js";

const KNOWN = new Set(["fal", "atlas"]);

function review(over: Partial<Review>): Review {
  return {
    id: "r_1",
    offering: "fal:x",
    scope: "private",
    created_at: "2026-10-27T10:00:00.000Z",
    updated_at: "2026-10-27T10:00:00.000Z",
    ...over,
  };
}

describe("scrubText", () => {
  it.each([
    ["an OpenAI-style key", "use sk-abcdefghijklmnop1234 today", "use [redacted] today"],
    ["a Google API key", "key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123 here", "key [redacted] here"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123", "token [redacted]"],
    ["a bearer token", "Authorization: Bearer abcdefgh12345678", "Authorization: [redacted]"],
    ["a key=value secret", "api_key=supersecretvalue123", "[redacted]"],
    ["a token: value pair", "token: xyz987654", "[redacted]"],
  ])("removes %s", (_label, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("drops the query of a signed media URL but keeps its host and path", () => {
    expect(scrubText("see https://cdn.example.com/a.mp4?X-Amz-Signature=abc123&x=1 end")).toBe(
      "see https://cdn.example.com/a.mp4?[redacted] end",
    );
  });

  it("replaces a data: URI payload", () => {
    expect(scrubText("pic data:image/png;base64,iVBORw0KGgo=")).toBe("pic data:[redacted]");
  });

  it("replaces e-mail addresses", () => {
    expect(scrubText("mail jane.doe@example.com for access")).toBe("mail [email] for access");
  });

  it("removes control and bidirectional override characters", () => {
    expect(scrubText("bad\u0007ctl‮bidi​zw")).toBe("badctlbidizw");
  });

  it("normalises to NFC so composed and decomposed Vietnamese compare equal", () => {
    const composed = "Quảng cáo";
    const decomposed = composed.normalize("NFD");
    expect(scrubText(decomposed)).toBe(composed);
  });

  it("leaves ordinary review text untouched", () => {
    const text = "Good motion, weak lip sync at 1080p.";
    expect(scrubText(text)).toBe(text);
  });
});

describe("cleanReview", () => {
  const base = { offering: "fal:bytedance/seedance-2.5/text-to-video", scope: "private" as const };

  it("keeps a score and scrubs the text before it is stored", () => {
    const out = cleanReview({ ...base, score: 4, text: "Fine, mail me at a@b.io" });
    expect(out).toMatchObject({ score: 4, text: "Fine, mail me at [email]" });
  });

  it("accepts a text-only review and a score-only review", () => {
    expect(cleanReview({ ...base, text: "Nice" })).toMatchObject({ text: "Nice" });
    expect(cleanReview({ ...base, score: 5 })).toMatchObject({ score: 5 });
  });

  it("requires a score, aspect scores or text", () => {
    expect(() => cleanReview({ ...base })).toThrow(
      new ValidationError("A review needs a score, aspect scores or text."),
    );
  });

  it("refuses text that is still over the limit after scrubbing", () => {
    const text = "a".repeat(LIMITS.text + 1);
    expect(() => cleanReview({ ...base, text })).toThrow(ValidationError);
    expect(() => cleanReview({ ...base, text })).toThrow(`the limit is ${LIMITS.text}.`);
  });

  it("accepts text of exactly the limit", () => {
    expect(cleanReview({ ...base, text: "a".repeat(LIMITS.text) }).text).toHaveLength(LIMITS.text);
  });

  it("refuses more than 10 pros, and a pro longer than 200 characters", () => {
    expect(() =>
      cleanReview({ ...base, score: 3, pros: Array.from({ length: 11 }, (_, i) => `p${i}`) }),
    ).toThrow("At most 10 pros entries.");
    expect(() => cleanReview({ ...base, score: 3, pros: ["x".repeat(201)] })).toThrow(
      ValidationError,
    );
  });

  it("slugs the use case and de-duplicates tags", () => {
    const out = cleanReview({
      ...base,
      score: 3,
      use_case: "Product UGC",
      tags: ["Lip Sync", "lip sync"],
    });
    expect(out).toMatchObject({ use_case: "product-ugc", tags: ["lip-sync"] });
  });

  it("refuses a score outside 1 to 5", () => {
    expect(() => cleanReview({ ...base, score: 6 })).toThrow(
      "score must be a whole number from 1 to 5.",
    );
  });

  it("does not accept a review that has aspect scores but no content", () => {
    expect(() => cleanReview({ ...base, aspects: {} as never })).toThrow(
      new ValidationError("A review needs a score, aspect scores or text."),
    );
  });

  it("records a verified run only when one is passed", () => {
    const out = cleanReview({
      ...base,
      score: 4,
      verified_usage: { history_id: "h_1", ts: "2026-10-27T10:00:00.000Z" },
    });
    expect(out.verified_usage).toEqual({ history_id: "h_1", ts: "2026-10-27T10:00:00.000Z" });
    expect(cleanReview({ ...base, score: 4 }).verified_usage).toBeUndefined();
  });
});

describe("cleanNote", () => {
  const base = { offering: "fal:x", use_case: "Product UGC", scope: "private" as const };

  it("accepts the three verdicts and rejects any other", () => {
    for (const verdict of ["recommended", "avoid", "mixed"]) {
      expect(cleanNote({ ...base, verdict }).verdict).toBe(verdict);
    }
    expect(() => cleanNote({ ...base, verdict: "good" })).toThrow("Invalid verdict good.");
  });

  it("scrubs the note text and slugs the use case", () => {
    const out = cleanNote({
      ...base,
      verdict: "avoid",
      text: "api_key=abcdef123",
      weaknesses: ["slow"],
    });
    expect(out).toMatchObject({
      use_case: "product-ugc",
      text: "[redacted]",
      weaknesses: ["slow"],
    });
  });
});

describe("parseScope", () => {
  it("defaults to private and accepts project", () => {
    expect(parseScope(undefined)).toBe("private");
    expect(parseScope("project")).toBe("project");
    expect(parseScope("PRIVATE")).toBe("private");
  });

  it.each(["team", "public"])(
    "refuses the %s scope and explains where sharing would need the remote store",
    (scope) => {
      expect(() => parseScope(scope)).toThrow(ValidationError);
      expect(() => parseScope(scope)).toThrow("shares the review beyond this machine");
      expect(() => parseScope(scope)).toThrow("Use private or project.");
    },
  );

  it("refuses an unknown scope with the valid list", () => {
    expect(() => parseScope("galaxy")).toThrow("Invalid scope galaxy. Valid: private, project");
  });
});

describe("parseScore", () => {
  it("accepts whole numbers from 1 to 5, including as text", () => {
    expect([1, 5, "3", "5"].map((v) => parseScore("score", v as never))).toEqual([1, 5, 3, 5]);
  });

  it.each([0, 6, 3.5, "abc", "", "4.5", -1])("refuses %s", (value) => {
    expect(() => parseScore("score", value as never)).toThrow(
      "score must be a whole number from 1 to 5.",
    );
  });

  it("returns nothing when no score was given", () => {
    expect(parseScore("score", undefined)).toBeUndefined();
  });
});

describe("parseAspects", () => {
  it("reads comma and repeated name=score pairs", () => {
    expect(parseAspects(["quality=4,speed=5", "motion=2"])).toEqual({
      quality: 4,
      speed: 5,
      motion: 2,
    });
  });

  it("refuses an aspect name it does not know, with the valid list", () => {
    expect(() => parseAspects(["color=3"])).toThrow(
      "Unknown aspect color. Valid: quality, fidelity, motion, audio, speed, value, reliability",
    );
  });

  it("refuses an aspect score outside 1 to 5", () => {
    expect(() => parseAspects(["quality=6"])).toThrow(
      "quality must be a whole number from 1 to 5.",
    );
    expect(() => parseAspects(["quality="])).toThrow("quality must be a whole number from 1 to 5.");
  });

  it("refuses an aspect given without a score", () => {
    expect(() => parseAspects(["quality"])).toThrow("quality must be a whole number from 1 to 5.");
  });

  it("returns nothing for no aspects", () => {
    expect(parseAspects(undefined)).toBeUndefined();
    expect(parseAspects([])).toBeUndefined();
  });
});

describe("slug", () => {
  it("turns Vietnamese with diacritics and đ into an ASCII kebab slug", () => {
    expect(slug("use case", "Quảng cáo Đẹp", 60)).toBe("quang-cao-dep");
  });

  it("lower-cases and joins words", () => {
    expect(slug("use case", "Product UGC", 60)).toBe("product-ugc");
  });

  it("refuses a value with no letters or digits", () => {
    expect(() => slug("use case", "!!!", 60)).toThrow('Invalid use case: "!!!"');
  });

  it("refuses a slug longer than the limit", () => {
    expect(() => slug("use case", "a".repeat(61), 60)).toThrow(
      "use case is longer than 60 characters.",
    );
  });

  it("returns nothing when no value was given", () => {
    expect(slug("use case", undefined, 60)).toBeUndefined();
  });
});

describe("parseOffering", () => {
  it("accepts <provider>:<model> for a known provider", () => {
    expect(parseOffering("fal:bytedance/seedance-2.5/text-to-video", KNOWN)).toBe(
      "fal:bytedance/seedance-2.5/text-to-video",
    );
  });

  it("refuses an unknown provider and points at the provider list", () => {
    expect(() => parseOffering("nope:model", KNOWN)).toThrow(
      "Unknown provider nope. List them: multix catalog providers",
    );
  });

  it("refuses a reference without a model", () => {
    expect(() => parseOffering("fal", KNOWN)).toThrow("use <provider>:<model id>.");
  });
});

describe("summarizeReviews", () => {
  it("has no average when nothing is rated, rather than a made-up default", () => {
    const summary = summarizeReviews([review({ text: "only words" })]);
    expect(summary).toMatchObject({ reviews: 1, rated: 0, average: null });
  });

  it("averages the ratings to two decimals and counts each star", () => {
    const summary = summarizeReviews([
      review({ score: 4 }),
      review({ score: 5 }),
      review({ score: 5, verified_usage: { history_id: "h_1", ts: "t" } }),
      review({ text: "no score" }),
    ]);
    expect(summary).toMatchObject({
      reviews: 4,
      rated: 3,
      average: 4.67,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 2 },
      verified: 1,
    });
  });

  it("reports the latest update", () => {
    const summary = summarizeReviews([
      review({ score: 1, updated_at: "2026-10-01T00:00:00.000Z" }),
      review({ score: 2, updated_at: "2026-10-20T00:00:00.000Z" }),
    ]);
    expect(summary.latest_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("reports nothing for an empty list", () => {
    expect(summarizeReviews([])).toMatchObject({ reviews: 0, average: null, latest_at: null });
  });
});
