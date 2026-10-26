/**
 * Live catalog reads for `multix models --live`: response parsing, the TTL
 * cache, forced refresh, and what happens offline. fetch is injected; no
 * network calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FetchFn, readCatalog } from "../../../src/capabilities/model-discovery.js";
import {
  DEFAULT_MODELS_TTL_S,
  discoverCatalog,
} from "../../../src/commands/agent/model-discovery-cache.js";

type Route = { status?: number; body: unknown } | Error;

/** fetch that answers by URL substring, in order, and records what it was asked. */
function fakeFetch(routes: Array<[string, Route]>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const index = routes.findIndex(([key]) => url.includes(key));
    if (index < 0) throw new Error(`unexpected fetch ${url}`);
    const [[, route]] = routes.splice(index, 1) as [[string, Route]];
    if (route instanceof Error) throw route;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as FetchFn;
  return { fn, calls };
}

const falPage = (ids: string[], next?: string) => ({
  models: ids.map((id) => ({
    endpoint_id: id,
    metadata: { display_name: id.toUpperCase(), status: "active" },
  })),
  has_more: next !== undefined,
  next_cursor: next ?? null,
});

describe("catalog parsing", () => {
  it("reads fal pages by cursor and keeps id, name and status", async () => {
    const { fn, calls } = fakeFetch([
      ["cursor=c2", { body: falPage(["b/tts"]) }],
      ["category=text-to-speech", { body: falPage(["a/tts", ""], "c2") }],
    ]);
    const read = await readCatalog("fal", "speech", fn);
    expect(read.models).toEqual([
      { provider: "fal", model: "a/tts", task: "speech", name: "A/TTS", status: "active" },
      { provider: "fal", model: "b/tts", task: "speech", name: "B/TTS", status: "active" },
    ]);
    expect(read.truncated).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.every((u) => u.startsWith("https://api.fal.ai/v1/models?"))).toBe(true);
  });

  it("stops after a bounded number of fal pages and says the list is truncated", async () => {
    const pages: Array<[string, Route]> = Array.from({ length: 10 }, (_, i) => [
      "api.fal.ai",
      { body: falPage([`m/${i}`], `c${i + 1}`) },
    ]);
    const { fn, calls } = fakeFetch(pages);
    const read = await readCatalog("fal", "image", fn);
    expect(read.truncated).toBe(true);
    expect(calls.length).toBeLessThan(10);
    expect(read.models).toHaveLength(calls.length);
  });

  it("reads OpenRouter speech models with voices and pricing, and image-edit needs image input", async () => {
    const speech = fakeFetch([
      [
        "output_modalities=speech",
        {
          body: {
            data: [
              {
                id: "v/tts",
                name: "V TTS",
                supported_voices: ["alloy", 3],
                pricing: { prompt: "0.000001", image: 0 },
                expiration_date: "2027-01-01",
              },
              { name: "no id" },
            ],
          },
        },
      ],
    ]);
    expect((await readCatalog("openrouter", "speech", speech.fn)).models).toEqual([
      {
        provider: "openrouter",
        model: "v/tts",
        task: "speech",
        name: "V TTS",
        status: "expires 2027-01-01",
        voices: ["alloy"],
        pricing: { prompt: "0.000001" },
      },
    ]);
    const edit = fakeFetch([
      [
        "output_modalities=image",
        {
          body: {
            data: [
              { id: "t2i", architecture: { input_modalities: ["text"] } },
              { id: "edit", architecture: { input_modalities: ["text", "image"] } },
            ],
          },
        },
      ],
    ]);
    const models = (await readCatalog("openrouter", "image-edit", edit.fn)).models;
    expect(models.map((m) => m.model)).toEqual(["edit"]);
  });

  it("throws on HTTP errors and unexpected shapes, without the query string", async () => {
    const http = fakeFetch([["openrouter.ai", { status: 503, body: {} }]]);
    await expect(readCatalog("openrouter", "speech", http.fn)).rejects.toThrow(
      "HTTP 503 from openrouter.ai",
    );
    const shape = fakeFetch([["api.fal.ai", { body: { items: [] } }]]);
    await expect(readCatalog("fal", "speech", shape.fn)).rejects.toThrow(/no models list/);
  });
});

describe("catalog cache", () => {
  let dir: string;
  let clock: number;
  const now = () => clock;
  const ttlSeconds = 60;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-models-cache-"));
    clock = Date.parse("2026-10-26T00:00:00Z");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fal = (ids: string[]) => fakeFetch([["api.fal.ai", { body: falPage(ids) }]]);

  it("fetches once, then serves the cache within the TTL", async () => {
    const first = fal(["a/tts"]);
    const fresh = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: first.fn,
    });
    expect(fresh.source).toMatchObject({
      provider: "fal",
      task: "speech",
      state: "fresh",
      fetched_at: "2026-10-26T00:00:00.000Z",
    });
    expect(fs.existsSync(path.join(dir, "fal-speech.json"))).toBe(true);

    clock += 30_000;
    const unused = fal(["b/tts"]);
    const cached = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: unused.fn,
    });
    expect(cached.source.state).toBe("cached");
    expect(cached.models.map((m) => m.model)).toEqual(["a/tts"]);
    expect(unused.calls).toEqual([]);
  });

  it("refetches after the TTL and on refresh, picking up renamed models", async () => {
    await discoverCatalog("fal", "speech", { dir, ttlSeconds, now, fetchFn: fal(["old/tts"]).fn });
    clock += 61_000;
    const expired = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: fal(["new/tts"]).fn,
    });
    expect(expired.source.state).toBe("fresh");
    expect(expired.models.map((m) => m.model)).toEqual(["new/tts"]);

    const refreshed = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      refresh: true,
      fetchFn: fal(["newer/tts"]).fn,
    });
    expect(refreshed.source.state).toBe("fresh");
    expect(refreshed.models.map((m) => m.model)).toEqual(["newer/tts"]);
  });

  it("falls back to the stale cache offline, and reports unavailable with no cache", async () => {
    const offline = () => fakeFetch([["api.fal.ai", new TypeError("fetch failed")]]).fn;
    const none = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: offline(),
    });
    expect(none).toEqual({
      source: { provider: "fal", task: "speech", state: "unavailable", error: "fetch failed" },
      models: [],
    });

    await discoverCatalog("fal", "speech", { dir, ttlSeconds, now, fetchFn: fal(["a/tts"]).fn });
    clock += 3_600_000;
    const stale = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: offline(),
    });
    expect(stale.source).toMatchObject({
      state: "stale",
      error: "fetch failed",
      fetched_at: "2026-10-26T00:00:00.000Z",
    });
    expect(stale.models.map((m) => m.model)).toEqual(["a/tts"]);
  });

  it("ignores a corrupt or mismatched cache file", async () => {
    fs.writeFileSync(path.join(dir, "fal-speech.json"), "{not json");
    const fresh = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: fal(["a/tts"]).fn,
    });
    expect(fresh.source.state).toBe("fresh");

    const file = path.join(dir, "fal-speech.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), task: "image" }),
    );
    const offline = fakeFetch([["api.fal.ai", new Error("down")]]).fn;
    const result = await discoverCatalog("fal", "speech", {
      dir,
      ttlSeconds,
      now,
      fetchFn: offline,
    });
    expect(result.source.state).toBe("unavailable");
  });

  it("does not fetch for a task the provider catalog has no category for", async () => {
    const { fn, calls } = fakeFetch([]);
    const result = await discoverCatalog("openrouter", "music", { dir, now, fetchFn: fn });
    expect(result).toEqual({
      source: { provider: "openrouter", task: "music", state: "unsupported" },
      models: [],
    });
    expect(calls).toEqual([]);
  });

  it("defaults to a one-day TTL", () => {
    expect(DEFAULT_MODELS_TTL_S).toBe(86_400);
  });
});
