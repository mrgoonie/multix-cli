/**
 * Pre-flight estimates for `topview *`: credit-billed legacy commands are
 * unknown (never $0); API Platform generate is priced from the verified table,
 * "proven" only when the request fixes every billed unit, "estimated" when the
 * provider bills measured usage or a unit is open, and unknown when it cannot
 * be priced.
 */

import { describe, expect, it } from "vitest";
import { estimateTopviewCommand } from "../../../../src/providers/topview/cost.js";

const AT = new Date("2026-10-28T12:00:00Z");
const generate = (options: Record<string, unknown>, at = AT) => {
  const estimate = estimateTopviewCommand("topview generate", options, at);
  if (!estimate) throw new Error("expected an estimate");
  return estimate;
};

describe("legacy (credit) commands", () => {
  it.each([
    "topview url-to-video",
    "topview materials-to-video",
    "topview export",
    "topview video-avatar",
    "topview product-avatar",
    "topview product-anyshoot",
  ])("%s is unknown with the credit rules as assumptions", (command) => {
    const estimate = estimateTopviewCommand(command, {}, AT);
    expect(estimate).toMatchObject({
      status: "unknown",
      reason: "credits_only",
      provider: "topview",
      low_usd: null,
      expected_usd: null,
      high_usd: null,
      upper_bound: "none",
    });
    expect(estimate?.assumptions.length).toBeGreaterThan(0);
  });

  it.each(["topview status", "topview upload", "topview credits", "topview models"])(
    "%s bills nothing and has no estimator",
    (command) => {
      expect(estimateTopviewCommand(command, {}, AT)).toBeUndefined();
    },
  );
});

describe("topview generate: proven caps", () => {
  it("prices T1 per second at an explicit resolution and duration", () => {
    const e = generate({
      model: "topview/topview-t1/text-to-video",
      prompt: "a cat",
      duration: "10",
      resolution: "1080p",
    });
    expect(e).toMatchObject({ status: "estimated", upper_bound: "proven", high_usd: 4.056 });
    expect(e.low_usd).toBe(e.high_usd);
  });

  it("uses T1's declared defaults (720p, 5s) as a proven cap", () => {
    const e = generate({ model: "topview/topview-t1/text-to-video", prompt: "a cat" });
    expect(e).toMatchObject({ upper_bound: "proven", high_usd: 0.8245 });
  });

  it("is proven for wan only when resolution and duration are both set", () => {
    const e = generate({
      model: "alibaba/wan-3.0/text-to-video",
      prompt: "a cat",
      duration: 10,
      resolution: "720P",
    });
    expect(e).toMatchObject({ upper_bound: "proven", high_usd: 0.832 });
  });

  it("adds MiniMax's per-image charge beyond five images", () => {
    const image = (role?: string) => ({
      type: "image_url",
      ...(role ? { role } : {}),
      image_url: { url: "https://images.example.com/a.png" },
    });
    const e = generate({
      model: "minimax/minimax-h3/image-to-video",
      input: JSON.stringify({
        content: [image("first_frame"), image(), image(), image(), image(), image(), image()],
      }),
      duration: "6",
    });
    expect(e).toMatchObject({ upper_bound: "proven" });
    expect(e.high_usd).toBeCloseTo(0.0648 * 6 + 2 * 0.0259, 6);
  });

  it("accepts MCP-style kebab-case option names", () => {
    const e = generate({
      model: "minimax/minimax-h3/text-to-video",
      prompt: "a cat",
      ratio: "16:9",
      "idempotency-key": "ignored-by-the-estimate",
    });
    expect(e).toMatchObject({ upper_bound: "proven", high_usd: 0.324 });
  });
});

describe("topview generate: estimated", () => {
  it("never calls a usage-billed model proven", () => {
    const e = generate({
      model: "bytedance/seedance-2.0/text-to-video",
      prompt: "a cat",
      duration: "5",
      resolution: "720p",
    });
    expect(e).toMatchObject({ status: "estimated", upper_bound: "estimated", high_usd: 0.6425 });
  });

  it("uses the reference-video rate as expected and the standard rate as the high end", () => {
    const e = generate({
      model: "bytedance/seedance-2.0/omni-reference-to-video",
      prompt: "dance",
      input: JSON.stringify({
        content: [{ type: "video_url", video_url: { url: "https://videos.example.com/r.mp4" } }],
      }),
    });
    expect(e.expected_usd).toBeCloseTo(0.0789 * 5, 6);
    expect(e.high_usd).toBeCloseTo(0.1285 * 5, 6);
    expect(e.upper_bound).toBe("estimated");
  });

  it("assumes the maximum duration for automatic (-1)", () => {
    const e = generate({ model: "topview/topview-t1/text-to-video", prompt: "x", duration: "-1" });
    expect(e.upper_bound).toBe("estimated");
    expect(e.high_usd).toBeCloseTo(0.1649 * 30, 6);
    expect(e.expected_usd).toBeCloseTo(0.1649 * 5, 6);
  });

  it("assumes the highest resolution and longest duration when wan declares no defaults", () => {
    const e = generate({ model: "alibaba/wan-3.0/text-to-video", prompt: "x" });
    expect(e.upper_bound).toBe("estimated");
    expect(e.high_usd).toBeCloseTo(0.1664 * 30, 6);
  });

  it("prices gpt-image at the high end when resolution and quality are open", () => {
    const e = generate({ model: "openai/gpt-image-2/text-to-image", prompt: "a fox" });
    expect(e).toMatchObject({ upper_bound: "estimated", low_usd: 0.0848, high_usd: 1.3293 });
  });

  it("multiplies gpt-image by n at a fixed quality and resolution", () => {
    const e = generate({
      model: "openai/gpt-image-2/text-to-image",
      prompt: "a fox",
      resolution: "1k",
      input: JSON.stringify({ n: 2, quality: "low" }),
    });
    expect(e).toMatchObject({ upper_bound: "estimated", high_usd: 0.0098 });
  });

  it("bills a pixel size as 4k", () => {
    const e = generate({
      model: "openai/gpt-image-2/text-to-image",
      prompt: "a fox",
      input: JSON.stringify({ size: "1536x1024", quality: "medium" }),
    });
    expect(e.high_usd).toBe(0.3432);
  });
});

describe("topview generate: unknown, never $0", () => {
  const isUnknown = (reason: string) => ({
    status: "unknown",
    reason,
    low_usd: null,
    expected_usd: null,
    high_usd: null,
  });

  it("needs --model", () => {
    expect(generate({ prompt: "x" })).toMatchObject(isUnknown("missing_input"));
  });

  it("has no price for a model outside the verified list", () => {
    expect(generate({ model: "openai/sora-9/text-to-video" })).toMatchObject(isUnknown("no_price"));
  });

  it("has no price at an unlisted resolution", () => {
    expect(
      generate({ model: "topview/topview-t1/text-to-video", prompt: "x", resolution: "4k" }),
    ).toMatchObject(isUnknown("no_price"));
  });

  it("goes stale after the maximum price age", () => {
    expect(
      generate(
        { model: "topview/topview-t1/text-to-video", prompt: "x" },
        new Date("2027-06-01T00:00:00Z"),
      ),
    ).toMatchObject(isUnknown("stale"));
  });

  it("reports an invalid request instead of guessing", () => {
    expect(
      generate({ model: "topview/topview-t1/text-to-video", input: "{not json" }),
    ).toMatchObject(isUnknown("invalid_input"));
    expect(generate({ model: "topview/topview-t1/text-to-video", duration: "five" })).toMatchObject(
      isUnknown("invalid_input"),
    );
    expect(
      generate({ model: "topview/topview-t1/text-to-video", image: "https://x.example.com/a.png" }),
    ).toMatchObject(isUnknown("invalid_input"));
  });
});
