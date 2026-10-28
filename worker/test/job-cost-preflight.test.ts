/**
 * The job tools' pre-flight cost check: commands priced by a live provider
 * quote (Sume) ask the keyless estimate endpoint through the injected fetch;
 * other commands keep the static estimate. No network calls.
 */

import { describe, expect, it } from "vitest";
import { costPreflight } from "../src/jobs/job-tools.js";

const ESTIMATE_URL = "https://api.sume.com/v1/open/estimate";
const QUOTE = {
  data: {
    model: "gpt-image-2",
    currency: "USD",
    usd: "0.79",
    billing: { unit: "image", quantity: 1, resolution: "2K" },
  },
};

function quoteFetch(response: () => Response) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    return response();
  };
  return { fn, calls };
}

const ok = () => Response.json(QUOTE);

describe("costPreflight", () => {
  it("does nothing without estimate or max_cost_usd", async () => {
    const { fn, calls } = quoteFetch(ok);
    expect(await costPreflight("sume image", { options: { model: "gpt-image-2" } }, fn)).toBe(
      undefined,
    );
    expect(calls).toHaveLength(0);
  });

  it("returns the live Sume quote for an estimate-only call", async () => {
    const { fn, calls } = quoteFetch(ok);
    const out = await costPreflight(
      "sume image",
      { options: { model: "gpt-image-2", resolution: "2K", prompt: "a cup" }, estimate: true },
      fn,
    );
    expect(out).toMatchObject({
      estimate_only: true,
      command: "sume image",
      estimate: { status: "estimated", expected_usd: 0.79, upper_bound: "proven" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ESTIMATE_URL);
    expect(calls[0]?.body).toEqual({ model: "gpt-image-2", input: { resolution: "2K" } });
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses max_cost_usd below the quote with BUDGET_EXCEEDED", async () => {
    const { fn } = quoteFetch(ok);
    await expect(
      costPreflight("sume image", { options: { model: "gpt-image-2" }, max_cost_usd: 0.5 }, fn),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("allows max_cost_usd at or above the quote", async () => {
    const { fn } = quoteFetch(ok);
    expect(
      await costPreflight("sume image", { options: { model: "gpt-image-2" }, max_cost_usd: 1 }, fn),
    ).toBe(undefined);
  });

  it("refuses max_cost_usd with BUDGET_UNPROVEN when the quote fails", async () => {
    const { fn } = quoteFetch(() => new Response("upstream down", { status: 503 }));
    await expect(
      costPreflight("sume video", { options: { model: "kling-4" }, max_cost_usd: 100 }, fn),
    ).rejects.toMatchObject({ code: "BUDGET_UNPROVEN" });
  });

  it("reports the verdict instead of throwing for an estimate with a limit", async () => {
    const { fn } = quoteFetch(ok);
    const out = await costPreflight(
      "sume image",
      { options: { model: "gpt-image-2" }, estimate: true, max_cost_usd: 0.5 },
      fn,
    );
    expect(out?.budget).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  it("keeps the static estimate for commands without a live quote", async () => {
    const { fn, calls } = quoteFetch(ok);
    const out = await costPreflight(
      "elevenlabs tts",
      { options: { text: "Hello" }, estimate: true },
      fn,
    );
    expect(out?.estimate).toMatchObject({ provider: "elevenlabs" });
    expect(calls).toHaveLength(0);
  });
});
