import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/config.js";
import { HTML_SECURITY_HEADERS } from "../src/http-responses.js";
import { MODELS_SCRIPT, MODELS_SCRIPT_HASH } from "../src/pages/models-page-script.js";
import { buildModelsData } from "../src/routes/models-catalog-data.js";
import { handleModels } from "../src/routes/models-routes.js";

const snapshot = {
  schema: "multix.live-prices/v1" as const,
  fetched_at: "2026-11-19T00:00:00.000Z",
  sources: [
    {
      provider: "atlas",
      url: "https://api.atlascloud.ai/api/v1/models",
      state: "fresh" as const,
      fetched_at: "2026-11-19T00:00:00.000Z",
      count: 2,
    },
  ],
  listings: [
    {
      provider: "atlas",
      model: "acme/listed-video",
      task: "video" as const,
      name: "Acme <b>Video</b>",
      prices: [{ label: "base_price", usd: 0.2, unit: null }],
    },
    { provider: "atlas", model: "acme/unpriced", task: "3d" as const, prices: [] },
  ],
};

describe("models page data", () => {
  const data = buildModelsData(snapshot, new Date("2026-11-19T00:00:00Z"));

  it("keeps verified rate cards, adds listing rows and command rows", () => {
    expect(data.rows.some((r) => r.kind === "verified")).toBe(true);
    expect(
      data.rows.some((r) => r.kind === "catalog" && r.rates.some((x) => x.status === "current")),
    ).toBe(true);
    const listed = data.rows.find((r) => r.id === "atlas:acme/listed-video");
    expect(listed).toMatchObject({
      kind: "listed",
      tasks: ["video"],
      listed: [{ usd: 0.2, unit: null }],
    });
    expect(listed?.price_link).toBeUndefined();
    expect(data.rows.some((r) => r.kind === "command" && r.provider === "leonardo")).toBe(true);
  });

  it("links every row without a price to the provider instead of showing $0", () => {
    for (const r of data.rows) {
      const priced = r.rates.some((x) => x.status === "current") || r.listed.length > 0;
      if (!priced) expect(r.price_link, r.id).toMatch(/^https:\/\//);
      expect(r.listed.every((p) => p.usd > 0)).toBe(true);
    }
    expect(data.rows.find((r) => r.id === "atlas:acme/unpriced")?.price_link).toBe(
      "https://www.atlascloud.ai/pricing/models",
    );
  });

  it("still lists shipped prices when no live snapshot could be read", () => {
    const offline = buildModelsData(undefined);
    expect(offline.sources).toEqual([]);
    expect(offline.rows.filter((r) => r.kind !== "command").length).toBeGreaterThan(100);
  });
});

describe("/models routes", () => {
  const env = {} as WorkerEnv;
  const offlineFetch = (async () =>
    new Response("down", { status: 503 })) as unknown as typeof fetch;

  it("serves the HTML page with the script allowed by hash and the data escaped", async () => {
    const res = await handleModels(new Request("https://mcp.example.com/models?lang=vi"), env, {
      fetch: offlineFetch,
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="mx-models-data"');
    expect(body).toContain("Model và <em>giá</em>");
    expect(body).not.toMatch(/<script type="application\/json" id="mx-models-data">[\s\S]*<\/b>/);
    expect(res.headers.get("content-security-policy")).toContain(`'${MODELS_SCRIPT_HASH}'`);
  });

  it("serves JSON with CORS and rejects writes", async () => {
    const res = await handleModels(new Request("https://mcp.example.com/models.json"), env, {
      fetch: offlineFetch,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { schema: string; rows: unknown[] };
    expect(body.schema).toBe("multix.models-page/v1");
    expect(body.rows.length).toBeGreaterThan(100);
    const post = await handleModels(
      new Request("https://mcp.example.com/models", { method: "POST" }),
      env,
      {},
    );
    expect(post.status).toBe(405);
  });

  it("keeps the CSP hash in sync with the script", () => {
    expect(MODELS_SCRIPT_HASH).toBe(
      `sha256-${createHash("sha256").update(MODELS_SCRIPT).digest("base64")}`,
    );
    expect(HTML_SECURITY_HEADERS["content-security-policy"]).toContain(`'${MODELS_SCRIPT_HASH}'`);
  });
});
