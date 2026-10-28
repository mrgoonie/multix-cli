import { describe, expect, it } from "vitest";
import {
  legacyCredits,
  legacyOutputs,
  platformChargedUsd,
  platformOutputs,
} from "../../../../src/providers/topview/task-output.js";

const task = (extra: Record<string, unknown>) => ({ taskId: "t1", status: "success", ...extra });

describe("legacyOutputs", () => {
  it("m2v prefers exported videos over previews", () => {
    const t = task({
      previewVideos: [{ videoUrl: "https://cdn.test/p.mp4" }],
      exportVideos: [{ videoUrl: "https://cdn.test/e.mp4" }],
    });
    expect(legacyOutputs("m2v", t).urls).toEqual(["https://cdn.test/e.mp4"]);
    expect(legacyOutputs("m2v", task({ previewVideos: t.previewVideos })).urls).toEqual([
      "https://cdn.test/p.mp4",
    ]);
  });

  it("an export never falls back to previews", () => {
    const t = task({ previewVideos: [{ videoUrl: "https://cdn.test/p.mp4" }] });
    expect(legacyOutputs("m2v-export", t).urls).toEqual([]);
  });

  it("reads each kind's documented result field", () => {
    expect(
      legacyOutputs("video-avatar", task({ outputVideoUrl: "https://cdn.test/a.mp4" })).urls,
    ).toEqual(["https://cdn.test/a.mp4"]);
    expect(
      legacyOutputs(
        "product-avatar-image",
        task({ replaceProductResult: [{ url: "https://cdn.test/1.png" }] }),
      ).urls,
    ).toEqual(["https://cdn.test/1.png"]);
    expect(
      legacyOutputs("product-avatar-video", task({ "finishedVideoUrl ": "https://cdn.test/v.mp4" }))
        .urls,
    ).toEqual(["https://cdn.test/v.mp4"]);
    expect(
      legacyOutputs(
        "anyshoot-model",
        task({
          anyfitImages: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }],
        }),
      ).urls,
    ).toEqual(["https://cdn.test/a.png", "https://cdn.test/b.png"]);
  });

  it("keeps https only and counts the rest as skipped", () => {
    const out = legacyOutputs(
      "anyshoot-background",
      task({ anyfitImages: [{ url: "http://cdn.test/a.png" }, { url: "iVBORw0KGgo=" }] }),
    );
    expect(out).toEqual({ urls: [], skipped: 2 });
  });
});

describe("credits and charges", () => {
  it("reports finite, non-negative credits only", () => {
    expect(legacyCredits(task({ costCredit: 5 }))).toBe(5);
    expect(legacyCredits(task({ costCredit: "5" }))).toBeUndefined();
    expect(legacyCredits(task({}))).toBeUndefined();
  });

  it("a RESERVED hold is not spend; CAPTURED and RELEASED are", () => {
    const p = { id: "p", status: "completed", charged_usd: "0.42" };
    expect(platformChargedUsd({ ...p, billing_state: "RESERVED" })).toBeUndefined();
    expect(platformChargedUsd({ ...p, billing_state: "CAPTURED" })).toBe(0.42);
    expect(platformChargedUsd({ ...p, billing_state: "RELEASED", charged_usd: "0" })).toBe(0);
    expect(
      platformChargedUsd({ ...p, billing_state: "CAPTURED", charged_usd: "-1" }),
    ).toBeUndefined();
  });

  it("platform outputs are the https entries of outputs[]", () => {
    expect(
      platformOutputs({ id: "p", status: "completed", outputs: ["https://cdn.test/o.mp4"] }).urls,
    ).toEqual(["https://cdn.test/o.mp4"]);
  });
});
