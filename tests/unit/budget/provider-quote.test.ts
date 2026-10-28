/**
 * Live provider quotes: a Sume estimate becomes a proven single-amount
 * CostEstimate; anything that cannot be quoted is "unknown", never $0.
 */

import { describe, expect, it } from "vitest";
import { quoteCommand, quotedCommands } from "../../../src/budget/provider-quote.js";
import { SUME_ESTIMATE_URL } from "../../../src/providers/sume/models.js";
import { createFakeSume } from "../providers/sume/fake-sume.js";

const AT = new Date("2026-10-28T09:00:00.000Z");
const QUOTE = {
  data: {
    model: "kling-4",
    currency: "USD",
    usd: "1.68",
    usd_micros: 1_680_000,
    route: "video-router",
    billing: { unit: "second", quantity: 10, duration_seconds: 10, resolution: "1080p" },
  },
};

describe("quoteCommand", () => {
  it("quotes sume image and sume video only", async () => {
    expect(quotedCommands()).toEqual(["sume image", "sume video"]);
    const fake = createFakeSume({});
    expect(await quoteCommand("runway video", { model: "x" }, { fetch: fake.fetch })).toBe(
      undefined,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("turns a Sume estimate into a proven quote without sending the prompt or a key", async () => {
    const fake = createFakeSume({ [`POST ${SUME_ESTIMATE_URL}`]: [{ json: QUOTE }] });
    const estimate = await quoteCommand(
      "sume video",
      { model: "kling-4", prompt: "secret prompt", duration: "10", resolution: "1080p" },
      { fetch: fake.fetch, at: AT },
    );
    expect(estimate).toMatchObject({
      status: "estimated",
      currency: "USD",
      provider: "sume",
      model: "kling-4",
      low_usd: 1.68,
      expected_usd: 1.68,
      high_usd: 1.68,
      upper_bound: "proven",
      at: AT.toISOString(),
      rate: { source: SUME_ESTIMATE_URL, last_checked: AT.toISOString() },
    });
    expect(estimate?.assumptions[0]).toBe("Billed as 10 × second (10 s, 1080p).");
    expect(estimate?.assumptions.join(" ")).toMatch(/unset are priced at the model's default/);
    const [call] = fake.calls;
    expect(call?.body).toEqual({
      model: "kling-4",
      input: { duration: 10, resolution: "1080p" },
    });
    expect(JSON.stringify(call?.body)).not.toContain("secret prompt");
    expect(call?.headers.authorization).toBeUndefined();
  });

  it.each([
    ["a server error", { status: 503, json: { error: { code: "unavailable" } } }],
    ["a malformed body", { json: { data: { usd: 1.2 } } }],
    ["a network error", { throws: new TypeError("fetch failed") }],
  ])("is unknown (never $0) after %s", async (_name, response) => {
    const fake = createFakeSume({ [`POST ${SUME_ESTIMATE_URL}`]: [response] });
    const estimate = await quoteCommand(
      "sume image",
      { model: "gpt-image-2" },
      { fetch: fake.fetch, at: AT },
    );
    expect(estimate).toMatchObject({
      status: "unknown",
      reason: "quote_failed",
      low_usd: null,
      expected_usd: null,
      high_usd: null,
      upper_bound: "none",
    });
  });

  it("is unknown without a model or with a local file, without a request", async () => {
    const fake = createFakeSume({});
    const noModel = await quoteCommand("sume image", {}, { fetch: fake.fetch });
    expect(noModel).toMatchObject({ status: "unknown", reason: "missing_input" });
    const local = await quoteCommand(
      "sume image",
      { model: "gpt-image-2", image: ["./cup.png"] },
      { fetch: fake.fetch },
    );
    expect(local).toMatchObject({ status: "unknown", reason: "missing_input" });
    expect(local?.detail).toContain("multix sume upload");
    expect(fake.calls).toHaveLength(0);
  });
});
