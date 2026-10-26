import { describe, expect, it } from "vitest";
import { fetchProviderBalances } from "../src/usage/provider-balances.js";
import { jsonResponse, mockFetch, route } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 26, 12);
const OPENROUTER_KEY = "sk-or-v1-secret-value-0123456789";
const ELEVENLABS_KEY = "sk_elevenlabs_secret_value_0123";

const openRouterOk = route("GET", /^https:\/\/openrouter\.ai\/api\/v1\/credits$/, () =>
  jsonResponse({ data: { total_credits: 25, total_usage: 7.5 } }),
);
const elevenLabsOk = route("GET", /^https:\/\/api\.elevenlabs\.io\/v1\/user\/subscription$/, () =>
  jsonResponse({ character_count: 1200, character_limit: 10000, tier: "starter" }),
);

describe("fetchProviderBalances", () => {
  it("reads OpenRouter credits and the ElevenLabs quota with the saved keys", async () => {
    const { fetch, calls } = mockFetch(openRouterOk, elevenLabsOk);
    const balances = await fetchProviderBalances(
      { OPENROUTER_API_KEY: OPENROUTER_KEY, ELEVENLABS_API_KEY: ELEVENLABS_KEY },
      fetch,
      NOW,
    );
    expect(balances).toEqual([
      {
        provider: "elevenlabs",
        status: "ok",
        checkedAt: NOW,
        kind: "subscription_quota",
        unit: "characters",
        remaining: 8800,
        used: 1200,
        limit: 10000,
        detail: null,
      },
      {
        provider: "openrouter",
        status: "ok",
        checkedAt: NOW,
        kind: "cash",
        unit: "USD",
        remaining: 17.5,
        used: 7.5,
        limit: 25,
        detail: null,
      },
    ]);
    const byHost = Object.fromEntries(calls.map((c) => [new URL(c.url).host, c.headers]));
    expect(byHost["openrouter.ai"]?.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(byHost["api.elevenlabs.io"]?.["xi-api-key"]).toBe(ELEVENLABS_KEY);
  });

  it("maps refused keys to forbidden and other failures to error without echoing the provider", async () => {
    const leaky = `{"error":"invalid key ${ELEVENLABS_KEY}"}`;
    const refused = mockFetch(
      route("GET", /elevenlabs/, () => new Response(leaky, { status: 401 })),
      route("GET", /openrouter/, () => new Response(`boom ${OPENROUTER_KEY}`, { status: 500 })),
    );
    const balances = await fetchProviderBalances(
      { OPENROUTER_API_KEY: OPENROUTER_KEY, ELEVENLABS_API_KEY: ELEVENLABS_KEY },
      refused.fetch,
      NOW,
    );
    expect(balances.map((b) => [b.provider, b.status])).toEqual([
      ["elevenlabs", "forbidden"],
      ["openrouter", "error"],
    ]);
    for (const b of balances) {
      expect(b).toMatchObject({ kind: null, remaining: null, used: null, limit: null });
    }
    const text = JSON.stringify(balances);
    expect(text).not.toContain(ELEVENLABS_KEY);
    expect(text).not.toContain(OPENROUTER_KEY);
    expect(text).not.toContain("invalid key");
  });

  it("reports unreachable providers and unexpected answers as errors", async () => {
    const failing = async (input: string): Promise<Response> => {
      if (input.includes("openrouter")) throw new TypeError("network down");
      return jsonResponse({ character_count: "lots" });
    };
    const balances = await fetchProviderBalances(
      { OPENROUTER_API_KEY: OPENROUTER_KEY, ELEVENLABS_API_KEY: ELEVENLABS_KEY },
      failing,
      NOW,
    );
    expect(balances).toMatchObject([
      { provider: "elevenlabs", status: "error", detail: "The provider sent an unexpected answer" },
      { provider: "openrouter", status: "error", detail: "The provider could not be reached" },
    ]);
  });

  it("bounds every request with a timeout", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = async (_input: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return jsonResponse({ data: { total_credits: 1, total_usage: 0 } });
    };
    await fetchProviderBalances({ OPENROUTER_API_KEY: OPENROUTER_KEY }, fetch, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("lists other keyed providers as unsupported once each and omits providers without a key", async () => {
    const { fetch, calls } = mockFetch();
    const balances = await fetchProviderBalances(
      {
        GEMINI_API_KEY: "AIza-secret",
        REPLICATE_API_TOKEN: "r8_one",
        REPLICATE_API_KEY: "r8_two",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        ATLASCLOUD_API_KEY: "  ",
      },
      fetch,
      NOW,
    );
    expect(calls).toHaveLength(0);
    expect(balances.map((b) => [b.provider, b.status])).toEqual([
      ["gemini", "unsupported"],
      ["replicate", "unsupported"],
    ]);
    expect(await fetchProviderBalances({}, fetch, NOW)).toEqual([]);
  });
});
