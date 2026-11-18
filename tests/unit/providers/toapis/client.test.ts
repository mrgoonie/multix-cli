import { describe, expect, it } from "vitest";
import {
  ToapisClient,
  quoteEstimateUsd,
  quoteToapis,
  settledCostUsd,
  taskOutputUrls,
} from "../../../../src/providers/toapis/client.js";
import type { ToapisTask } from "../../../../src/providers/toapis/types.js";

type Call = { url: string; init?: RequestInit };

/** Injected fetch that answers each call with the next queued JSON body. */
function fakeFetch(responses: unknown[]) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responses.shift() ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const header = (c: Call | undefined, name: string) => new Headers(c?.init?.headers).get(name);

describe("ToapisClient", () => {
  it("requires a key", () => {
    expect(() => new ToapisClient({ apiKey: " " })).toThrow(/TOAPIS_API_KEY/);
  });

  it("submits, then polls until completed", async () => {
    const { fetch, calls } = fakeFetch([
      { id: "task_1", status: "" },
      { id: "task_1", status: "in_progress", progress: 50 },
      {
        id: "task_1",
        status: "completed",
        result: { data: [{ url: "https://cdn/x.mp4" }] },
        billing: { status: "settled", cost_usd: "0.076642" },
      },
    ]);
    const client = new ToapisClient({ apiKey: "sk-test", fetch, baseUrl: "https://t.example/" });
    const sub = await client.submit("video", { model: "seedance-2-fast", prompt: "p" });
    expect(sub).toMatchObject({ id: "task_1", status: "queued" });
    expect(calls[0]?.url).toBe("https://t.example/v1/videos/generations");
    expect(header(calls[0], "authorization")).toBe("Bearer sk-test");

    const task = await client.waitForTask("video", "task_1", { intervalMs: 1, timeoutMs: 5000 });
    expect(calls[2]?.url).toBe("https://t.example/v1/videos/generations/task_1");
    expect(taskOutputUrls(task)).toEqual(["https://cdn/x.mp4"]);
    expect(settledCostUsd(task)).toBeCloseTo(0.076642, 6);
  });

  it("rejects a task id with path characters", async () => {
    const { fetch } = fakeFetch([]);
    const client = new ToapisClient({ apiKey: "k", fetch });
    await expect(client.getTask("image", "../x")).rejects.toThrow(/Invalid ToAPIs task id/);
  });

  it("uploads multipart and returns the public URL", async () => {
    const { fetch, calls } = fakeFetch([{ success: true, data: { url: "https://cdn/u.png" } }]);
    const client = new ToapisClient({ apiKey: "k", fetch });
    const up = await client.upload("images", new Uint8Array([1, 2]), "a.png", "image/png");
    expect(up.url).toBe("https://cdn/u.png");
    expect(calls[0]?.url).toBe("https://toapis.com/v1/uploads/images");
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
  });

  it("refuses an unsafe task id returned by the server", async () => {
    const { fetch } = fakeFetch([{ id: "../../evil" }]);
    const client = new ToapisClient({ apiKey: "k", fetch });
    await expect(client.submit("image", { model: "m", prompt: "p" })).rejects.toThrow(
      /Invalid ToAPIs task id/,
    );
  });

  it("lists models by type", async () => {
    const { fetch, calls } = fakeFetch([{ data: [{ id: "seedance-2" }] }]);
    const models = await new ToapisClient({ apiKey: "k", fetch }).listModels("video");
    expect(models.map((m) => m.id)).toEqual(["seedance-2"]);
    expect(calls[0]?.url).toContain("/v1/models?type=video");
  });

  it("reports no cost before billing settles", () => {
    const task = { id: "t", status: "completed", billing: { status: "pending" } } as ToapisTask;
    expect(settledCostUsd(task)).toBeUndefined();
  });
});

describe("quoteToapis", () => {
  it("sends no key and maps rows back by key", async () => {
    const { fetch, calls } = fakeFetch([
      {
        data: [
          { key: "1", success: false },
          {
            key: "0",
            success: true,
            data: {
              model: "wan2.6",
              charge_type: "per_second",
              unit_price: 0.06,
              estimated_price: 0.3,
              display_price: "$0.06/s",
            },
          },
        ],
      },
    ]);
    const [a, b] = await quoteToapis(
      [
        { model: "wan2.6", params: { duration: 5 } },
        { model: "x", params: {} },
      ],
      { fetch },
    );
    expect(a?.estimated_price).toBe(0.3);
    expect(b).toBeNull();
    expect(header(calls[0], "authorization")).toBeNull();
    expect(quoteEstimateUsd(a ?? null, { duration: 5 })).toBe(0.3);
  });
});
