import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATLAS_KEY,
  CF_TOKEN,
  HEYGEN_KEY,
  REPLICATE_KEY,
  TOKEN,
  callTool,
  fullEnv,
  jsonResponse,
  mockFetch,
  route,
  rpc,
} from "./helpers.js";

const REPLICATE = "https://api.replicate.com/v1";
const ATLAS = "https://api.atlascloud.ai/api/v1";

afterEach(() => vi.restoreAllMocks());

describe("MCP protocol", () => {
  it("initializes over Streamable HTTP", async () => {
    const body = await rpc(fullEnv(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(body.result.serverInfo.name).toBe("multix");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists the five multix tools with input schemas", async () => {
    const body = await rpc(fullEnv(), "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "multix_generate_image",
      "multix_generate_video",
      "multix_list_providers",
      "multix_prediction_cancel",
      "multix_prediction_status",
    ]);
    const video = body.result.tools.find(
      (t: { name: string }) => t.name === "multix_generate_video",
    );
    expect(video.inputSchema.required).toEqual(expect.arrayContaining(["provider", "prompt"]));
  });

  it("reports an unknown tool as an error", async () => {
    const body = await rpc(fullEnv(), "tools/call", { name: "multix_nope", arguments: {} });
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});

describe("multix_list_providers", () => {
  it("reports configuration and limits without revealing credentials", async () => {
    const env = fullEnv({
      HEYGEN_API_KEY: undefined,
      MULTIX_MCP_ALLOWED_PROVIDERS: "replicate,heygen",
    });
    const result = await callTool(env, "multix_list_providers", {});
    const text = result.content[0].text as string;
    for (const secret of [TOKEN, REPLICATE_KEY, ATLAS_KEY, CF_TOKEN, "acct123"]) {
      expect(text).not.toContain(secret);
    }
    const byId = Object.fromEntries(
      result.structuredContent.providers.map((p: { id: string }) => [p.id, p]),
    );
    expect(byId.replicate).toMatchObject({ enabled: true, configured: true, cancel: true });
    expect(byId.heygen).toMatchObject({ enabled: true, configured: false, image: null });
    expect(byId.atlascloud.enabled).toBe(false);
    expect(byId.cloudflare.image).toBeNull();
    expect(result.structuredContent.limits).toMatchObject({
      max_outputs: 4,
      max_video_seconds: 10,
      default_video_seconds: 5,
      allowed_resolutions: ["480p", "720p", "1080p"],
    });
  });
});

describe("multix_generate_image", () => {
  it("runs Replicate with Prefer: wait and returns output URLs", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/models\/black-forest-labs\/flux-schnell\/predictions$/, () =>
        jsonResponse({
          id: "img123",
          status: "succeeded",
          output: [
            "https://replicate.delivery/a/out-0.webp",
            "https://replicate.delivery/a/out-1.webp",
          ],
        }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "replicate", prompt: "a red fox", num_outputs: 2, aspect_ratio: "16:9" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      provider: "replicate",
      id: "img123",
      done: true,
      succeeded: true,
      model: "black-forest-labs/flux-schnell",
      outputs: [
        "https://replicate.delivery/a/out-0.webp",
        "https://replicate.delivery/a/out-1.webp",
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${REPLICATE_KEY}`);
    expect(calls[0]?.headers.prefer).toBe("wait=20");
    expect(calls[0]?.body).toEqual({
      input: { prompt: "a red fox", num_outputs: 2, aspect_ratio: "16:9" },
    });
  });

  it("submits to Atlas Cloud and polls until the image is ready", async () => {
    const { fetch, calls } = mockFetch(
      route("GET", /\/api\/v1\/models$/, () => jsonResponse({ code: 200, data: [] })),
      route("POST", /\/model\/generateImage$/, () =>
        jsonResponse({ code: 200, data: { id: "atl-1", status: "processing" } }),
      ),
      route("GET", /\/model\/prediction\/atl-1$/, () =>
        jsonResponse({
          code: 200,
          data: { id: "atl-1", status: "completed", outputs: ["https://cdn.atlascloud.ai/x.png"] },
        }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "atlascloud", prompt: "a lighthouse", seed: 7 },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      provider: "atlascloud",
      id: "atl-1",
      done: true,
      succeeded: true,
      outputs: ["https://cdn.atlascloud.ai/x.png"],
    });
    const submit = calls.find((c) => c.url === `${ATLAS}/model/generateImage`);
    expect(submit?.body).toEqual({
      model: "black-forest-labs/flux-schnell",
      prompt: "a lighthouse",
      seed: 7,
    });
    expect(submit?.headers.authorization).toBe(`Bearer ${ATLAS_KEY}`);
  });

  it("returns the prediction id for polling when wait_seconds is 0", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/predictions$/, () =>
        jsonResponse({ id: "img999", status: "starting", output: null }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "replicate", prompt: "x", wait_seconds: 0 },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      done: false,
      next: {
        tool: "multix_prediction_status",
        arguments: { provider: "replicate", prediction_id: "img999" },
      },
    });
    expect(calls[0]?.headers.prefer).toBeUndefined();
  });

  it("enforces the output cap before calling the provider", async () => {
    const { fetch, calls } = mockFetch();
    const result = await callTool(
      fullEnv({ MULTIX_MCP_MAX_OUTPUTS: "2" }),
      "multix_generate_image",
      { provider: "replicate", prompt: "x", num_outputs: 3 },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at most 2/);
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized prompts and unknown providers via schema validation", async () => {
    const { fetch, calls } = mockFetch();
    const long = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "replicate", prompt: "x".repeat(4001) },
      { fetch },
    );
    expect(long.isError).toBe(true);
    const unknown = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "openai", prompt: "x" },
      { fetch },
    );
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("enforces the provider and model allowlists", async () => {
    const { fetch, calls } = mockFetch();
    const provider = await callTool(
      fullEnv({ MULTIX_MCP_ALLOWED_PROVIDERS: "atlascloud" }),
      "multix_generate_image",
      { provider: "replicate", prompt: "x" },
      { fetch },
    );
    expect(provider.content[0].text).toMatch(/not enabled/);
    const model = await callTool(
      fullEnv({ MULTIX_MCP_ALLOWED_MODELS: "replicate:black-forest-labs/flux-schnell" }),
      "multix_generate_image",
      { provider: "replicate", model: "owner/expensive-model", prompt: "x" },
      { fetch },
    );
    expect(model.content[0].text).toMatch(/not enabled/);
    expect(calls).toHaveLength(0);
  });

  it("reports an unconfigured provider without contacting it", async () => {
    const { fetch, calls } = mockFetch();
    const result = await callTool(
      fullEnv({ REPLICATE_API_TOKEN: undefined }),
      "multix_generate_image",
      { provider: "replicate", prompt: "x" },
      { fetch },
    );
    expect(result.content[0].text).toBe("Provider replicate is not configured on this server");
    expect(calls).toHaveLength(0);
  });

  it("scrubs keys and signed URLs from provider errors", async () => {
    const error = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch } = mockFetch(
      route("POST", /\/predictions$/, () =>
        jsonResponse(
          {
            detail: `bad token ${REPLICATE_KEY} see https://signed.example.com/f.png?X-Amz-Signature=deadbeef`,
          },
          500,
        ),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_image",
      { provider: "replicate", prompt: "secret prompt text" },
      { fetch },
    );
    const text = result.content[0].text as string;
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Replicate server error \(500\)/);
    expect(text).not.toContain(REPLICATE_KEY);
    expect(text).not.toContain("deadbeef");
    const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(REPLICATE_KEY);
    expect(logged).not.toContain("secret prompt text");
  });
});

describe("multix_generate_video", () => {
  it("starts a Replicate video without blocking and polls it by id", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/models\/prunaai\/p-video\/predictions$/, () =>
        jsonResponse({ id: "vid123", status: "starting", output: null }),
      ),
      route("GET", /\/predictions\/vid123$/, () =>
        jsonResponse({
          id: "vid123",
          status: "succeeded",
          output: "https://replicate.delivery/v.mp4",
        }),
      ),
    );
    const env = fullEnv();
    const started = await callTool(
      env,
      "multix_generate_video",
      {
        provider: "replicate",
        prompt: "waves",
        duration: 5,
        image_url: "https://images.example.com/first.png",
      },
      { fetch },
    );
    expect(started.structuredContent).toMatchObject({
      id: "vid123",
      status: "starting",
      done: false,
    });
    expect(calls[0]?.headers.prefer).toBeUndefined();
    expect(calls[0]?.body).toEqual({
      input: { prompt: "waves", duration: 5, image: "https://images.example.com/first.png" },
    });

    const status = await callTool(
      env,
      "multix_prediction_status",
      { provider: "replicate", prediction_id: "vid123" },
      { fetch },
    );
    expect(status.structuredContent).toMatchObject({
      done: true,
      succeeded: true,
      outputs: ["https://replicate.delivery/v.mp4"],
    });
    expect(status.structuredContent.next).toBeUndefined();
  });

  it("uses Atlas Cloud's image-to-video default when image_url is given", async () => {
    const { fetch, calls } = mockFetch(
      route("GET", /\/api\/v1\/models$/, () => jsonResponse({ code: 200, data: [] })),
      route("POST", /\/model\/generateVideo$/, () =>
        jsonResponse({ code: 200, data: { id: "atv-1", status: "processing" } }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      {
        provider: "atlascloud",
        prompt: "pan",
        image_url: "https://images.example.com/a.png",
        duration: 5,
      },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      id: "atv-1",
      done: false,
      model: "bytedance/seedance-v1-pro-fast/image-to-video",
    });
    expect(calls.find((c) => c.url === `${ATLAS}/model/generateVideo`)?.body).toMatchObject({
      image: "https://images.example.com/a.png",
      duration: 5,
    });
  });

  it("fails closed on Atlas Cloud when the schema is unavailable and duration is omitted", async () => {
    const { fetch, calls } = mockFetch(
      route("GET", /\/api\/v1\/models$/, () => jsonResponse({ code: 500 }, 500)),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/pass duration \(at most 10s\)/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends an explicit capped duration on Atlas Cloud when the schema default is too long", async () => {
    const model = "vendor/long-video";
    const schemaUrl = "https://schemas.example.com/long-video.json";
    const { fetch, calls } = mockFetch(
      route("GET", /\/api\/v1\/models$/, () =>
        jsonResponse({ code: 200, data: [{ model, schema: schemaUrl }] }),
      ),
      route("GET", /long-video\.json$/, () =>
        jsonResponse({
          paths: {
            "/api/v1/model/generateVideo": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        properties: {
                          prompt: { type: "string" },
                          duration: { type: "integer", default: 12 },
                        },
                        required: ["prompt"],
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ),
      route("POST", /\/model\/generateVideo$/, () =>
        jsonResponse({ code: 200, data: { id: "atv-2", status: "processing" } }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(calls.find((c) => c.url === `${ATLAS}/model/generateVideo`)?.body).toEqual({
      model,
      prompt: "pan",
      duration: 5,
    });
  });

  it("starts and polls a HeyGen video, returning the output URL as given", async () => {
    const signed = "https://files.heygen.ai/v.mp4?Expires=1&Signature=abc";
    const { fetch, calls } = mockFetch(
      route("POST", /\/v3\/models\/videos$/, () =>
        jsonResponse({ data: { video_id: "hg1", status: "pending" } }),
      ),
      route("GET", /\/v3\/models\/videos\/hg1$/, () =>
        jsonResponse({ data: { video_id: "hg1", status: "completed", video_url: signed } }),
      ),
    );
    const env = fullEnv();
    const started = await callTool(
      env,
      "multix_generate_video",
      { provider: "heygen", prompt: "a sunrise", duration: 5, resolution: "1080p" },
      { fetch },
    );
    expect(started.isError).toBeFalsy();
    expect(started.structuredContent).toMatchObject({ id: "hg1", done: false });
    expect(calls[0]?.headers["x-api-key"]).toBe(HEYGEN_KEY);
    expect(calls[0]?.body).toMatchObject({
      model: "heygen-video-1",
      prompt: "a sunrise",
      duration: 5,
    });

    const done = await callTool(
      env,
      "multix_prediction_status",
      { provider: "heygen", prediction_id: "hg1" },
      { fetch },
    );
    expect(done.structuredContent).toMatchObject({ succeeded: true, outputs: [signed] });
  });

  it("routes Cloudflare video through AI Gateway", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /gateway\.ai\.cloudflare\.com\/v1\/acct123\/gw1\/replicate\/predictions$/, () =>
        jsonResponse({ id: "cf1", status: "starting", output: null }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "cloudflare", prompt: "rain" },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      provider: "cloudflare",
      id: "cf1",
      done: false,
    });
    expect(calls[0]?.headers["cf-aig-authorization"]).toBe(`Bearer ${CF_TOKEN}`);
    expect(calls[0]?.headers["cf-aig-collect-log-payload"]).toBe("false");
    // duration omitted: the server default is sent so the provider default cannot exceed the cap.
    expect(calls[0]?.body).toMatchObject({ input: { prompt: "rain", duration: 5 } });
  });

  it.each(["replicate", "heygen"])(
    "sends the server default duration to %s when the caller omits it",
    async (provider) => {
      const { fetch, calls } = mockFetch(
        route("POST", /\/predictions$/, () => jsonResponse({ id: "v1", status: "starting" })),
        route("POST", /\/v3\/models\/videos$/, () =>
          jsonResponse({ data: { video_id: "v1", status: "pending" } }),
        ),
      );
      const result = await callTool(
        fullEnv({ MULTIX_MCP_MAX_VIDEO_SECONDS: "4" }),
        "multix_generate_video",
        { provider, prompt: "x" },
        { fetch },
      );
      const body = calls[0]?.body as { input?: { duration?: number }; duration?: number };
      if (provider === "replicate") {
        expect(result.isError).toBeFalsy();
        expect(body.input?.duration).toBe(4);
      } else {
        // HeyGen's minimum is 5s, so a 4s cap fails closed instead of billing the default.
        expect(result.isError).toBe(true);
        expect(calls).toHaveLength(0);
      }
    },
  );

  it("enforces the resolution allowlist", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/predictions$/, () => jsonResponse({ id: "v4k", status: "starting" })),
    );
    const denied = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "replicate", prompt: "x", resolution: "4k" },
      { fetch },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/resolution must be one of 480p, 720p, 1080p/);
    expect(calls).toHaveLength(0);

    const allowed = await callTool(
      fullEnv({ MULTIX_MCP_ALLOWED_RESOLUTIONS: "720p, 4K" }),
      "multix_generate_video",
      { provider: "replicate", prompt: "x", resolution: "4K" },
      { fetch },
    );
    expect(allowed.isError).toBeFalsy();
    expect(calls[0]?.body).toMatchObject({ input: { resolution: "4k" } });
  });

  it("enforces the duration cap", async () => {
    const { fetch, calls } = mockFetch();
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "replicate", prompt: "x", duration: 12 },
      { fetch },
    );
    expect(result.content[0].text).toMatch(/at most 10 seconds/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    "http://images.example.com/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
    "https://localhost/a.png",
    "https://metadata.google.internal/x",
    "https://user:pass@images.example.com/a.png",
    "https://images.example.com:8443/a.png",
    "https://2130706433/a.png",
    "file:///etc/passwd",
  ])("rejects unsafe image_url %s before any provider call", async (url) => {
    const { fetch, calls } = mockFetch();
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "replicate", prompt: "x", image_url: url },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("multix_prediction_status and multix_prediction_cancel", () => {
  it("cancels a Replicate prediction", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/predictions\/vid123\/cancel$/, () =>
        jsonResponse({ id: "vid123", status: "canceled", output: null }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_prediction_cancel",
      { provider: "replicate", prediction_id: "vid123" },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      status: "canceled",
      done: true,
      succeeded: false,
    });
    expect(calls[0]?.url).toBe(`${REPLICATE}/predictions/vid123/cancel`);
  });

  it("refuses cancel for providers without a cancel API", async () => {
    const result = await callTool(fullEnv(), "multix_prediction_cancel", {
      provider: "heygen",
      prediction_id: "hg1",
    });
    expect(result.isError).toBe(true);
  });

  it("rejects malformed prediction ids", async () => {
    const { fetch, calls } = mockFetch();
    const result = await callTool(
      fullEnv(),
      "multix_prediction_status",
      { provider: "atlascloud", prediction_id: "../../admin" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a failed provider job as a finished, unsuccessful result", async () => {
    const { fetch } = mockFetch(
      route("GET", /\/model\/prediction\/atl-9$/, () =>
        jsonResponse({ code: 200, data: { id: "atl-9", status: "failed", error: "NSFW blocked" } }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_prediction_status",
      { provider: "atlascloud", prediction_id: "atl-9" },
      { fetch },
    );
    expect(result.structuredContent).toMatchObject({
      done: true,
      succeeded: false,
      error: "NSFW blocked",
      outputs: [],
    });
  });
});
