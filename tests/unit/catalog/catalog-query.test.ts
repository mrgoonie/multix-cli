/**
 * The shared catalogue views (`catalogQuery`) that the CLI, the MCP tool and
 * the REST route all call: view dispatch, validation and the quote request.
 */

import { describe, expect, it } from "vitest";
import { CATALOG_VIEWS, catalogQuery, quoteRequestOf } from "../../../src/catalog/catalog-query.js";
import { CATALOG_SCHEMA } from "../../../src/catalog/catalog-types.js";
import { ValidationError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-28T12:00:00Z");
const none = () => false;
const fal = (p: string) => p === "fal";

// biome-ignore lint/suspicious/noExplicitAny: payloads are checked field by field
type Payload = Record<string, any>;

function run(query: Parameters<typeof catalogQuery>[0], ready = none, groups: string[] = ["fal"]) {
  return catalogQuery(query, ready, groups) as Payload;
}

describe("catalogQuery views", () => {
  it("tags every view with the catalogue schema", () => {
    for (const view of CATALOG_VIEWS) {
      const q =
        view === "show"
          ? { view, offering: "fal:bytedance/seedance-2.5/text-to-video", at: AT }
          : { view, at: AT };
      expect(run(q).schema, view).toBe(CATALOG_SCHEMA);
    }
  });

  it("lists providers with readiness and only the ready ones when asked", () => {
    const all = run({ view: "providers", at: AT }, fal, ["fal", "minimax"]);
    expect(all.providers.map((p: { id: string }) => p.id)).toContain("minimax");
    const ready = run({ view: "providers", ready: true, at: AT }, fal, ["fal", "minimax"]);
    expect(ready.providers.map((p: { id: string }) => p.id)).toEqual(["fal"]);
  });

  it("lists offerings sorted by id by default, with readiness on each", () => {
    const { offerings } = run({ view: "models", provider: "fal", at: AT }, fal);
    const ids = offerings.map((o: { id: string }) => o.id);
    expect(ids).toEqual([...ids].sort());
    expect(
      offerings.every(
        (o: { ready: boolean; provider: string }) => o.ready === (o.provider === "fal"),
      ),
    ).toBe(true);
  });

  it("keeps only offerings with a price when priced is set", () => {
    const { offerings } = run({ view: "models", priced: true, at: AT });
    expect(offerings.length).toBeGreaterThan(0);
    expect(offerings.every((o: { price_status: string }) => o.price_status === "priced")).toBe(
      true,
    );
  });

  it("filters offerings to the providers the caller has keys for", () => {
    const { offerings } = run({ view: "models", ready: true, at: AT }, fal);
    expect(offerings.every((o: { provider: string }) => o.provider === "fal")).toBe(true);
  });

  it("shows one offering by its reference", () => {
    const { offering } = run(
      { view: "show", offering: "fal:fal-ai/kling-video/v3/pro/text-to-video", at: AT },
      fal,
    );
    expect(offering).toMatchObject({
      id: "fal:fal-ai/kling-video/v3/pro/text-to-video",
      ready: true,
    });
  });

  it("asks which provider when a bare model id is offered by more than one", () => {
    expect(() =>
      run({ view: "show", offering: "bytedance/seedance-2.5/text-to-video", at: AT }),
    ).toThrow(
      new ValidationError(
        "bytedance/seedance-2.5/text-to-video is offered by atlas, fal; use one of atlas:bytedance/seedance-2.5/text-to-video, fal:bytedance/seedance-2.5/text-to-video.",
      ),
    );
  });

  it("names the missing offering when show finds nothing", () => {
    expect(() => run({ view: "show", offering: "fal:no/such-model", at: AT })).toThrow(
      new ValidationError("No offering fal:no/such-model."),
    );
  });

  it("needs an offering reference for show", () => {
    expect(() => run({ view: "show", at: AT })).toThrow(ValidationError);
  });

  it("returns a comparison, with the request time, for the compare view", () => {
    const { comparison } = run({
      view: "compare",
      task: "video",
      resolution: "720P",
      duration_s: 10,
      audio: true,
      aspect_ratio: "16:9",
      at: AT,
    });
    expect(comparison.request).toMatchObject({
      task: "video",
      resolution: "720p",
      duration_s: 10,
      audio: true,
      at: AT.toISOString(),
    });
    const fal = comparison.rows.find(
      (r: { offering: string }) => r.offering === "fal:bytedance/seedance-2.5/text-to-video",
    );
    expect(fal).toMatchObject({ status: "priced", total_usd: 4.6224, price_rank: 1 });
  });

  it("sorts offerings by price when asked and rejects an unknown sort", () => {
    expect(() => run({ view: "models", sort: "color", at: AT })).toThrow(/Invalid sort: color/);
    const { offerings } = run({ view: "models", task: "video", sort: "price", at: AT });
    expect(offerings[0].id).toBe("fal:fal-ai/kling-video/v3/standard/text-to-video");
  });

  it("filters offerings by resolution on the models view, case-insensitively", () => {
    const { offerings } = run({ view: "models", resolution: "1080P", at: AT });
    expect(offerings.map((o: { id: string }) => o.id)).toEqual([
      "atlas:bytedance/seedance-2.5/text-to-video",
      "fal:bytedance/seedance-2.5/text-to-video",
    ]);
  });
});

describe("catalogQuery validation", () => {
  it("rejects an unknown view", () => {
    expect(() => catalogQuery({ view: "prices" as never }, none, [])).toThrow(
      new ValidationError(`Invalid view: prices. Valid: ${CATALOG_VIEWS.join(", ")}`),
    );
  });

  it("rejects an unknown task with the valid list", () => {
    expect(() => run({ view: "models", task: "telepathy" })).toThrow(
      /Invalid task: telepathy\. Valid:/,
    );
  });

  it("rejects a non-positive duration in the compare view", () => {
    expect(() => run({ view: "compare", duration_s: 0, at: AT })).toThrow(
      "duration must be a positive number.",
    );
    expect(() => run({ view: "compare", duration_s: -5, at: AT })).toThrow(
      "duration must be a positive number.",
    );
    expect(() => run({ view: "compare", duration_s: Number.NaN, at: AT })).toThrow(
      "duration must be a positive number.",
    );
  });
});

describe("quoteRequestOf", () => {
  it("normalises resolution to lower case and keeps the pinned settings", () => {
    expect(
      quoteRequestOf({
        view: "compare",
        task: "video",
        resolution: "1080P",
        aspect_ratio: "16:9",
        audio: false,
        duration_s: 5,
        images: 2,
      }),
    ).toEqual({
      task: "video",
      resolution: "1080p",
      aspect_ratio: "16:9",
      audio: false,
      duration_s: 5,
      images: 2,
    });
  });

  it("leaves unpinned settings out, so the comparison sees them as open", () => {
    expect(quoteRequestOf({ view: "compare" })).toEqual({});
  });

  it("rejects an invalid task and a non-positive image count", () => {
    expect(() => quoteRequestOf({ view: "compare", task: "nope" })).toThrow(ValidationError);
    expect(() => quoteRequestOf({ view: "compare", images: 0 })).toThrow(
      "images must be a positive number.",
    );
  });
});
