/**
 * Provider requests carry API keys in headers. A provider API that redirects
 * to another origin (or to plain http) must never receive the key there.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../../src/core/errors.js";
import { createLogger } from "../../../src/core/logger.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";
import { AtlasCloudClient } from "../../../src/providers/atlascloud/client.js";
import { runCloudflareJson } from "../../../src/providers/cloudflare/client.js";
import {
  createCloudflareVideoPrediction,
  getCloudflareVideoPrediction,
} from "../../../src/providers/cloudflare/video-client.js";
import { apiPostBinary } from "../../../src/providers/elevenlabs/client.js";
import { downloadDub } from "../../../src/providers/elevenlabs/commands/dub.js";
import { _resetGeminiKeyCooldowns } from "../../../src/providers/gemini/key-pool.js";
import { uploadLocalFile } from "../../../src/providers/gemini/local-files.js";
import { downloadVeoVideo } from "../../../src/providers/gemini/veo.js";
import { HeygenClient } from "../../../src/providers/heygen/client.js";
import { postOpenAIForm } from "../../../src/providers/openai/client.js";
import { downloadOpenRouterVideo } from "../../../src/providers/openrouter/commands/video-status.js";
import type { OpenRouterVideoPollResponse } from "../../../src/providers/openrouter/video-client.js";
import { ReplicateClient } from "../../../src/providers/replicate/client.js";
import { RunwayClient } from "../../../src/providers/runway/client.js";
import { TopviewLegacyClient } from "../../../src/providers/topview/legacy-client.js";
import { findPlatformRoute } from "../../../src/providers/topview/models.js";
import { TopviewPlatformClient } from "../../../src/providers/topview/platform-client.js";

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

/**
 * Fake fetch answering from `routes` by exact URL, stubbed as globalThis.fetch.
 * Unless asked for `redirect: "manual"`, it follows redirects itself keeping
 * the headers, as fetch does for custom key headers. Records every request.
 */
function stubRoutes(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, headers: new Headers(init?.headers) });
    const route = routes[input];
    if (!route) throw new Error(`unexpected request to ${input}`);
    const res = route();
    const location = res.headers.get("location");
    if (init?.redirect !== "manual" && location) return fetch(location, init);
    return res;
  };
  vi.stubGlobal("fetch", fetch);
  return calls;
}

const moved = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

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

  it("Runway JSON calls (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(302);
    const client = new RunwayClient({ apiKey: KEY, fetch, sleep: async () => {} });
    await expect(client.getTask("0f0e0d0c-1111-4222-8333-444455556666")).rejects.toThrow();
    await expect(
      client.textToVideo({ model: "gen4.5", promptText: "x", ratio: "1280:720", duration: 5 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(leaked(calls, "https://api.dev.runwayml.com")).toBe(false);
  });

  it("Atlas Cloud JSON calls and uploads (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(308);
    const client = new AtlasCloudClient({ apiKey: KEY, fetch });
    await expect(client.getPrediction("abc123")).rejects.toThrow();
    await expect(client.uploadMedia(new Uint8Array([1]), "a.png", "image/png")).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(leaked(calls, "https://api.atlascloud.ai")).toBe(false);
  });

  it("TopView legacy calls (Authorization, Topview-Uid)", async () => {
    const { fetch, calls } = redirectingFetch(302);
    const client = new TopviewLegacyClient({ apiKey: KEY, uid: "uid-1", fetch });
    await expect(client.getTask("m2v", "task1")).rejects.toThrow();
    await expect(client.submit("m2v", { productName: "x" })).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(leaked(calls, "https://api.topview.ai")).toBe(false);
  });

  it("TopView API Platform calls and uploads (Authorization)", async () => {
    const { fetch, calls } = redirectingFetch(307);
    const client = new TopviewPlatformClient({ apiKey: KEY, fetch });
    const route = findPlatformRoute("bytedance/seedance-2.0-mini/text-to-video");
    if (!route) throw new Error("route missing");
    await expect(client.getPrediction("pred1")).rejects.toThrow();
    await expect(
      client.createPrediction(route, { prompt: "x" }, "idem-key-0001"),
    ).rejects.toThrow();
    await expect(client.uploadAsset(new Blob(["x"]), "a.png", "image")).rejects.toThrow();
    expect(calls).toHaveLength(3);
    expect(leaked(calls, "https://platform-backend.topview.ai")).toBe(false);
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

  it("Cloudflare AI Gateway video predictions (cf-aig-authorization), shared with the Worker", async () => {
    const { fetch, calls } = redirectingFetch(302);
    const config = {
      accountId: "account-id",
      apiToken: KEY,
      gatewayId: "gateway-id",
      replicateApiToken: `r8-${KEY}`,
    };
    await expect(
      createCloudflareVideoPrediction(config, { prompt: "p" }, { fetch }),
    ).rejects.toThrow(/HTTP 302/);
    await expect(getCloudflareVideoPrediction(config, "pred-1", { fetch })).rejects.toThrow(
      /HTTP 302/,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("cf-aig-authorization")).toBe(`Bearer ${KEY}`);
    expect(leaked(calls, "https://gateway.ai.cloudflare.com")).toBe(false);
  });

  it("Cloudflare cancels the body of an unfollowed redirect before failing", async () => {
    const cancel = vi.fn();
    const fetch = async () =>
      new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: EVIL } });
    const config = { accountId: "a", apiToken: KEY, gatewayId: "g", replicateApiToken: "r" };
    await expect(getCloudflareVideoPrediction(config, "pred-1", { fetch })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(cancel).toHaveBeenCalled();
  });
});

describe("a same-origin redirect loop is reported, not retried as a network error", () => {
  const loop = () => {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: String(input) } });
    };
    return { fetch, calls };
  };

  it("OpenAI keeps the 3xx status", async () => {
    const { fetch } = loop();
    vi.stubGlobal("fetch", fetch);
    const err = await postOpenAIForm("images/edits", new FormData(), KEY).catch((e) => e);
    expect(err).toMatchObject({ status: 302 });
    expect(err.message).toContain("too many redirects");
  });

  it("HeyGen asset upload does not retry it", async () => {
    const { fetch, calls } = loop();
    const client = new HeygenClient({ apiKey: KEY, fetch, maxAttempts: 3, sleep: async () => {} });
    await expect(
      client.uploadAsset({ data: new Uint8Array([1]), filename: "a.png", mimeType: "image/png" }),
    ).rejects.toMatchObject({ status: 302 });
    // One attempt: the first request plus 5 followed redirects.
    expect(calls).toHaveLength(6);
  });
});

describe("Gemini Files upload (x-goog-api-key)", () => {
  async function listen(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("refuses a redirect on the upload request instead of following it", async () => {
    _resetGeminiKeyCooldowns();
    const reached: Array<string | undefined> = [];
    const evil = await listen((req, res) => {
      reached.push(req.headers["x-goog-api-key"] as string | undefined);
      res.end("{}");
    });
    const api = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(307, { location: `http://127.0.0.1:${evil.port}/steal` });
        res.end();
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-gemini-upload-"));
    const realFetch = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
        realFetch(
          url.replace("https://generativelanguage.googleapis.com", `http://127.0.0.1:${api.port}`),
          init,
        ),
      );
      const file = path.join(dir, "doc.pdf");
      fs.writeFileSync(file, "%PDF-1.4");
      const err = await uploadLocalFile(file, { apiKey: KEY }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(reached).toEqual([]);
    } finally {
      await api.close();
      await evil.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("downloads that hand off to storage drop the key", () => {
  const STORAGE = "https://storage.test/out?sig=1";

  it("ElevenLabs dub download (xi-api-key)", async () => {
    const api = "https://api.elevenlabs.io/v1/dubbing/d1/audio/es";
    const calls = stubRoutes({
      [api]: moved(STORAGE),
      [STORAGE]: () => new Response("AUDIO", { status: 200 }),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-dub-"));
    try {
      await downloadDub(api, KEY, path.join(dir, "dub.mp4"));
      expect(fs.readFileSync(path.join(dir, "dub.mp4"), "utf8")).toBe("AUDIO");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(calls[0]?.headers.get("xi-api-key")).toBe(KEY);
    expect(calls[1]?.url).toBe(STORAGE);
    expect(leaked(calls, "https://api.elevenlabs.io")).toBe(false);
  });

  it("OpenRouter video download (Authorization)", async () => {
    const api = "https://openrouter.ai/api/v1/videos/job-1/content";
    const calls = stubRoutes({
      [api]: moved(STORAGE),
      [STORAGE]: () => new Response("VIDEO", { status: 200 }),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-or-"));
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubEnv("MULTIX_OUTPUT_DIR", dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    _resetOutputDir();
    try {
      const dest = await downloadOpenRouterVideo({
        jobId: "job-1",
        thumb: false,
        logger: createLogger({ verbose: false }),
        source: {} as OpenRouterVideoPollResponse,
      });
      expect(fs.readFileSync(dest, "utf8")).toBe("VIDEO");
    } finally {
      _resetOutputDir();
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[1]?.url).toBe(STORAGE);
    expect(leaked(calls, "https://openrouter.ai")).toBe(false);
  });
});

describe("Gemini Veo download (x-goog-api-key)", () => {
  async function download(uri: string, routes: Record<string, () => Response>) {
    const calls = stubRoutes(routes);
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
