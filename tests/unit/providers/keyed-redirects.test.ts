/**
 * Provider requests carry API keys in headers. A provider API that redirects
 * to another origin (or to plain http) must never receive the key there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasCloudClient } from "../../../src/providers/atlascloud/client.js";
import { runCloudflareJson } from "../../../src/providers/cloudflare/client.js";
import { apiPostBinary } from "../../../src/providers/elevenlabs/client.js";
import { downloadVeoVideo } from "../../../src/providers/gemini/veo.js";
import { HeygenClient } from "../../../src/providers/heygen/client.js";
import { postOpenAIForm } from "../../../src/providers/openai/client.js";
import { ReplicateClient } from "../../../src/providers/replicate/client.js";

const KEY = "SECRET-KEY-123";
const EVIL = "https://evil.test/collect";

interface Call {
  url: string;
  headers: Headers;
}

/**
 * Fake fetch: every request off evil.test is answered with `status` to
 * `target`, which answers 200 (and must never be reached). Unless the request
 * asks for `redirect: "manual"`, it follows redirects itself with the same
 * headers, as fetch does for custom key headers. Records every request.
 */
function redirectingFetch(status = 302, target = EVIL) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url === target) return new Response("{}", { status: 200 });
    if (init?.redirect !== "manual") return fetch(target, init);
    return new Response(null, { status, headers: { location: target } });
  };
  return { fetch, calls };
}

/** True when any request outside the provider's origin carried the key in any header. */
function leaked(calls: Call[], apiOrigin: string): boolean {
  return calls.some(
    (c) =>
      new URL(c.url).origin !== apiOrigin && [...c.headers.values()].some((v) => v.includes(KEY)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API requests never follow a redirect to another origin", () => {
  it("HeyGen JSON calls and asset uploads (X-Api-Key)", async () => {
    const { fetch, calls } = redirectingFetch(307);
    const client = new HeygenClient({ apiKey: KEY, fetch, maxAttempts: 1, sleep: async () => {} });
    await expect(client.getVideo("v1")).rejects.toThrow();
    await expect(
      client.uploadAsset({ data: new Uint8Array([1]), filename: "a.png", mimeType: "image/png" }),
    ).rejects.toThrow();
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      "https://api.heygen.com",
      "https://api.heygen.com",
    ]);
  });

  it("Replicate JSON calls (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(302);
    const client = new ReplicateClient({ apiKey: KEY, fetch, sleep: async () => {} });
    await expect(client.getPrediction("abc123")).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(leaked(calls, "https://api.replicate.com")).toBe(false);
  });

  it("Atlas Cloud JSON calls and uploads (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(308);
    const client = new AtlasCloudClient({ apiKey: KEY, fetch });
    await expect(client.getPrediction("abc123")).rejects.toThrow();
    await expect(client.uploadMedia(new Uint8Array([1]), "a.png", "image/png")).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(leaked(calls, "https://api.atlascloud.ai")).toBe(false);
  });

  it("OpenAI form posts (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(307);
    vi.stubGlobal("fetch", fetch);
    await expect(postOpenAIForm("images/edits", new FormData(), KEY)).rejects.toMatchObject({
      status: 307,
    });
    expect(calls).toHaveLength(1);
  });

  it("ElevenLabs binary posts (xi-api-key), including a downgrade to http", async () => {
    const { fetch, calls } = redirectingFetch(307, "http://api.elevenlabs.io/v1/x");
    vi.stubGlobal("fetch", fetch);
    await expect(apiPostBinary("text-to-speech/v", { text: "hi" }, KEY)).rejects.toMatchObject({
      status: 307,
    });
    expect(calls).toHaveLength(1);
  });

  it("Cloudflare Workers AI (Authorization)", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", KEY);
    const { fetch, calls } = redirectingFetch(307);
    vi.stubGlobal("fetch", fetch);
    await expect(runCloudflareJson("@cf/x/y", { prompt: "p" })).rejects.toThrow(/HTTP 307/);
    expect(calls).toHaveLength(1);
  });
});

describe("Gemini Veo download (x-goog-api-key)", () => {
  async function download(uri: string, routes: Record<string, () => Response>) {
    const calls: Call[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input, headers: new Headers(init?.headers) });
      const route = routes[input];
      if (!route) throw new Error(`unexpected request to ${input}`);
      const res = route();
      const location = res.headers.get("location");
      // Follow like fetch does (keeping custom headers) unless asked not to.
      if (init?.redirect !== "manual" && location) return fetch(location, init);
      return res;
    };
    vi.stubGlobal("fetch", fetch);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-veo-"));
    try {
      await downloadVeoVideo(KEY, uri, path.join(dir, "v.mp4"));
      return { calls, body: fs.readFileSync(path.join(dir, "v.mp4"), "utf8") };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const API = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";

  it.each([
    ["the storage host", "https://storage.googleapis.test/v.mp4?sig=1"],
    ["plain http", "http://generativelanguage.googleapis.com/v.mp4"],
  ])("sends the key to the API host only, not after a redirect to %s", async (_, target) => {
    const { calls, body } = await download(API, {
      [API]: () => new Response(null, { status: 302, headers: { location: target } }),
      [target]: () => new Response("VIDEO", { status: 200 }),
    });
    expect(body).toBe("VIDEO");
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe(KEY);
    expect(calls[1]?.url).toBe(target);
    expect(calls[1]?.headers.get("x-goog-api-key")).toBeNull();
  });

  it("never sends the key to an http:// URI on the API host", async () => {
    const uri = "http://generativelanguage.googleapis.com/v1beta/files/abc";
    const { calls } = await download(uri, { [uri]: () => new Response("V", { status: 200 }) });
    expect(calls[0]?.headers.get("x-goog-api-key")).toBeNull();
  });
});
