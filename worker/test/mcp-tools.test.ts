import { afterEach, describe, expect, it, vi } from "vitest";
import { ATLAS_VIDEO_SCHEMAS } from "./fixtures/atlas-video-schemas.js";
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
      allowed_resolutions: ["480p", "720p", "768p", "1080p"],
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

  /** Atlas catalog + schema + submit routes for one video model with the given inputs. */
  function atlasVideoModel(
    properties: Record<string, unknown>,
    required: string[] = ["prompt"],
    model = "vendor/test-video",
  ) {
    const schemaUrl = "https://schemas.example.com/test-video.json";
    const mock = mockFetch(
      route("GET", /\/api\/v1\/models$/, () =>
        jsonResponse({ code: 200, data: [{ model, schema: schemaUrl }] }),
      ),
      route("GET", /test-video\.json$/, () =>
        jsonResponse({
          paths: {
            "/api/v1/model/generateVideo": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        properties: { prompt: { type: "string" }, ...properties },
                        required,
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
    const submitted = () => mock.calls.find((c) => c.url === `${ATLAS}/model/generateVideo`)?.body;
    return { model, ...mock, submitted };
  }

  it("uses Atlas Cloud's image-to-video default when image_url is given", async () => {
    const { fetch, submitted } = atlasVideoModel(
      { image: { type: "string" }, duration: { type: "integer", default: 5 } },
      ["prompt", "image"],
      "bytedance/seedance-v1-pro-fast/image-to-video",
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
      id: "atv-2",
      done: false,
      model: "bytedance/seedance-v1-pro-fast/image-to-video",
    });
    expect(submitted()).toMatchObject({
      image: "https://images.example.com/a.png",
      duration: 5,
    });
  });

  it.each([
    ["duration omitted", {}],
    ["duration passed", { duration: 5 }],
    ["duration and resolution passed", { duration: 5, resolution: "720p" }],
  ])(
    "fails closed on Atlas Cloud video when the schema is unavailable (%s)",
    async (_label, extra) => {
      const { fetch, calls } = mockFetch(
        route("GET", /\/api\/v1\/models$/, () => jsonResponse({ code: 500 }, 500)),
      );
      const result = await callTool(
        fullEnv(),
        "multix_generate_video",
        { provider: "atlascloud", prompt: "pan", ...extra },
        { fetch },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(
        /schema could not be loaded.*request is not sent\. Retry later/,
      );
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    },
  );

  it("parses string durations such as 8s and sends the schema's format", async () => {
    const enumField = atlasVideoModel({
      duration: { type: "string", enum: ["4s", "8s", "12s"], default: "12s" },
    });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: enumField.model, prompt: "pan" },
      { fetch: enumField.fetch },
    );
    expect(enumField.submitted()).toMatchObject({ duration: "8s" });

    const requested = atlasVideoModel({
      duration: { type: "string", enum: ["4s", "8s"], default: "8s" },
    });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: requested.model, prompt: "pan", duration: 4 },
      { fetch: requested.fetch },
    );
    expect(requested.submitted()).toMatchObject({ duration: "4s" });

    const free = atlasVideoModel({ duration: { type: "string", default: "12s" } });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: free.model, prompt: "pan" },
      { fetch: free.fetch },
    );
    expect(free.submitted()).toMatchObject({ duration: "10s" });
  });

  it("unwraps anyOf length fields and rejects ambiguous ones", async () => {
    const nullable = atlasVideoModel({
      duration: { anyOf: [{ type: "integer", maximum: 20 }, { type: "null" }], default: 15 },
    });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: nullable.model, prompt: "pan" },
      { fetch: nullable.fetch },
    );
    expect(nullable.submitted()).toMatchObject({ duration: 10 });

    const ambiguous = atlasVideoModel({
      duration: { oneOf: [{ type: "integer" }, { type: "string", enum: ["auto"] }] },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: ambiguous.model, prompt: "pan" },
      { fetch: ambiguous.fetch },
    );
    expect(result.content[0].text).toMatch(/"duration" has a type this server cannot check/);
    expect(ambiguous.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    [
      "a non-numeric length field",
      { length: { type: "string", enum: ["short", "long"] } },
      /type this server cannot check/,
    ],
    [
      "an unknown length-like field",
      { duration_seconds: { type: "integer", default: 30 } },
      /length input "duration_seconds" this server cannot cap/,
    ],
    ...["frame_count", "num_frame", "clip_length", "video_len"].map(
      (name): [string, Record<string, unknown>, RegExp] => [
        `a numeric "${name}" field`,
        { [name]: { type: "integer", default: 300 } },
        new RegExp(`length input "${name}" this server cannot cap`),
      ],
    ),
    [
      "a length-like field wrapping a $ref in a nullable union",
      { clip_length: { anyOf: [{ $ref: "#/components/schemas/Len" }, { type: "null" }] } },
      /length input "clip_length" this server cannot cap/,
    ],
    [
      "a numeric-string length-like field",
      { clip_length: { type: "string", default: "30" } },
      /length input "clip_length" this server cannot cap/,
    ],
    [
      "frames with no frame rate above the cap",
      { num_frames: { type: "integer", default: 81 } },
      /"num_frames" has no allowed value/,
    ],
  ])("rejects %s before submit", async (_label, props, message) => {
    const { model, fetch, calls } = atlasVideoModel(props);
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(message);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ignores non-numeric inputs whose names mention frames", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      return_last_frame: { type: "boolean", default: false },
      first_frame: { type: "string" },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 5 });
  });

  it("caps frame counts using the schema frame rate", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      num_frames: { type: "integer", minimum: 17, maximum: 241, default: 241 },
      fps: { type: "integer", default: 16 },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", num_frames: 160 });
  });

  it("never sends a zero or negative length unless picked from the schema's positive values", async () => {
    const auto = atlasVideoModel({ duration: { type: "integer", default: 0 } });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: auto.model, prompt: "pan" },
      { fetch: auto.fetch },
    );
    expect(auto.submitted()).toMatchObject({ duration: 5 });

    const smart = atlasVideoModel({
      duration: { type: "integer", enum: [-1, 0, 4, 8], default: -1 },
    });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: smart.model, prompt: "pan" },
      { fetch: smart.fetch },
    );
    expect(smart.submitted()).toMatchObject({ duration: 4 });
  });

  it.each([
    ["a size default above the allowlist", { size: { type: "string", default: "3840*2160" } }],
    ["an unparseable size", { size: { type: "string", default: "landscape" } }],
    ["a width default above the allowlist", { width: { type: "integer", default: 2560 } }],
    ["a non-string resolution default", { resolution: { type: "integer", default: 2160 } }],
    ["a square size above the short edge", { size: { type: "string", default: "1920*1920" } }],
    [
      "width and height together above the short edge",
      { width: { type: "integer", default: 1920 }, height: { type: "integer", default: 1920 } },
    ],
    [
      "a resolution default outside a union with several members",
      {
        resolution: {
          anyOf: [{ type: "string", enum: ["720p", "4k"] }, { type: "string" }],
          default: "4k",
        },
      },
    ],
  ])("rejects %s on Atlas Cloud before submit", async (_label, props) => {
    const { model, fetch, calls } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      ...props,
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/would render at/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    [
      "a resolution union with no outer default",
      { resolution: { anyOf: [{ type: "string", enum: ["720p"] }, { type: "integer" }] } },
      "resolution",
    ],
    [
      "a resolution $ref",
      { resolution: { $ref: "#/components/schemas/Resolution" } },
      "resolution",
    ],
    [
      "a nullable resolution $ref",
      { resolution: { anyOf: [{ $ref: "#/components/schemas/Resolution" }, { type: "null" }] } },
      "resolution",
    ],
    ["a size allOf", { size: { allOf: [{ type: "string" }], default: "640*360" } }, "size"],
    [
      "a width union with several members",
      { width: { oneOf: [{ type: "integer" }, { type: "string" }] } },
      "width",
    ],
  ])("rejects %s on Atlas Cloud before submit", async (_label, props, field) => {
    const { model, fetch, calls } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      ...props,
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      `input "${field}" has a schema this server cannot check; ${
        field === "resolution" ? "pass a resolution or use another model" : "use another model"
      }`,
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("checks a caller resolution even when the schema shape is unreadable", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      resolution: { $ref: "#/components/schemas/Resolution" },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan", resolution: "720p" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toMatchObject({ resolution: "720p" });
  });

  it.each([
    [
      "boolean cost switches",
      {
        generate_audio: { type: "boolean", default: true },
        sound: { type: "boolean", default: true },
        audio: { type: "boolean", default: true },
        enable_thinking: { type: "boolean", default: true },
        hdr: { type: "boolean", default: false },
      },
      { generate_audio: false, sound: false, audio: false, enable_thinking: false, hdr: false },
    ],
    [
      "a yes/no audio enum",
      { generate_audio: { type: "string", enum: ["yes", "no"], default: "yes" } },
      { generate_audio: "no" },
    ],
    [
      "output counts",
      {
        count: { type: "integer", enum: [1, 2, 4], default: 2 },
        num_videos: { type: "integer", minimum: 1, maximum: 4, default: 4 },
        n: { type: "string", enum: ["1", "2"], default: "2" },
      },
      { count: 1, num_videos: 1, n: "1" },
    ],
    [
      "known price tiers",
      {
        thinking_level: { type: "string", enum: ["default", "high", "low"], default: "default" },
        motion: { type: "string", enum: ["high", "low"], default: "high" },
        bitrate_mode: { type: "string", enum: ["standard", "high"], default: "high" },
        mode: { type: "string", enum: ["wan-std", "wan-pro"], default: "wan-pro" },
      },
      { thinking_level: "low", motion: "low", bitrate_mode: "standard", mode: "wan-std" },
    ],
    [
      "a tier enum with an unknown value and a known default",
      { motion: { type: "string", enum: ["auto", "low", "high"], default: "high" } },
      { motion: "low" },
    ],
    [
      "output counts named *_count",
      {
        video_count: { type: "integer", minimum: 1, maximum: 4, default: 2 },
        output_count: { type: "integer", enum: [1, 2], default: 2 },
        samples_count: { type: "integer", default: 3 },
      },
      { video_count: 1, output_count: 1, samples_count: 1 },
    ],
    [
      "a std/pro mode",
      { mode: { type: "string", enum: ["std", "pro"], default: "pro" } },
      { mode: "std" },
    ],
    [
      "a standard/professional mode",
      { mode: { type: "string", enum: ["professional", "standard"], default: "professional" } },
      { mode: "standard" },
    ],
  ])("sends Atlas Cloud %s at their cheapest values", async (_label, props, expected) => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      ...props,
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 5, ...expected });
  });

  it.each([
    ["an audio input URL", { audio: { type: "string" } }],
    [
      "a tier enum with unknown values and an unknown default",
      { motion: { type: "string", enum: ["auto", "fast", "slow"], default: "auto" } },
    ],
    ["a free-text tier at its cheapest default", { motion: { type: "string", default: "low" } }],
    [
      "counts that are not output counts",
      {
        face_count: { type: "integer", default: 3 },
        speaker_count: { type: "integer", default: 2 },
      },
    ],
    [
      "a mode with no known ladder",
      { mode: { type: "string", enum: ["fast", "slow"], default: "slow" } },
    ],
  ])("leaves %s alone", async (_label, props) => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      ...props,
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 5 });
  });

  it.each([
    [
      "an unreadable cost switch",
      { generate_audio: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      /"generate_audio" raises the price and has a schema that cannot be read/,
    ],
    [
      "a $ref cost switch",
      { enable_thinking: { $ref: "#/components/schemas/Flag" } },
      /"enable_thinking" raises the price and has a schema that cannot be read/,
    ],
    [
      "a cost switch enum with no off value",
      { sound: { type: "string", enum: ["stereo", "mono"], default: "stereo" } },
      /"sound" raises the price and cannot be switched off/,
    ],
    [
      "an output count whose minimum is above 1",
      { num_outputs: { type: "integer", minimum: 2, maximum: 4, default: 2 } },
      /"num_outputs" raises the price and cannot be set to one output/,
    ],
    [
      "an output count enum without 1",
      { num_samples: { type: "integer", enum: [2, 4], default: 2 } },
      /"num_samples" raises the price and cannot be set to one output/,
    ],
    [
      "a non-numeric output count",
      { batch_size: { type: "string", enum: ["small", "large"] } },
      /"batch_size" raises the price and cannot be set to one output/,
    ],
    [
      "an unreadable output count",
      { num_videos: { oneOf: [{ type: "integer" }, { type: "string" }] } },
      /"num_videos" raises the price and has a schema that cannot be read/,
    ],
    [
      "a free-text tier with a higher default",
      { thinking_level: { type: "string", default: "high" } },
      /"thinking_level" raises the price and cannot be set to its lowest price tier/,
    ],
    [
      "an unreadable tier",
      { motion: { $ref: "#/components/schemas/Motion" } },
      /"motion" raises the price and has a schema that cannot be read/,
    ],
  ])("rejects %s on Atlas Cloud before submit", async (_label, props, message) => {
    const { model, fetch, calls } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      ...props,
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(message);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    ["bytedance/seedance-2.5/text-to-video", {}, { duration: 5, generate_audio: false }],
    [
      "bytedance/seedance-2.0-mini/text-to-video",
      {},
      { duration: 5, bitrate_mode: "standard", generate_audio: false },
    ],
    [
      "alibaba/wan-3.0-prime/reference-to-video",
      {},
      { duration: 5, audio: false, enable_thinking: false },
    ],
    ["alibaba/wan-2.5/video-extend", {}, { duration: 5 }],
    ["google/gemini-omni-1.1-flash/video-extend", {}, { duration: 10, thinking_level: "low" }],
    [
      "midjourney/v8.2/image-to-video",
      { image_url: "https://images.example.com/a.png" },
      { image: "https://images.example.com/a.png", motion: "low" },
    ],
    ["pixverse/c1/text-to-video", {}, { duration: 5, sound: false }],
    ["kwaivgi/kling-video-o3-4k/text-to-video", {}, { duration: 5, sound: false }],
    ["luma/ray-3.2/text-to-video", {}, { duration: 5, hdr: false }],
  ])("submits the real %s schema with cheap values", async (name, args, expected) => {
    const { model, fetch, submitted } = atlasVideoModel(
      ATLAS_VIDEO_SCHEMAS[name] as Record<string, unknown>,
      ["prompt"],
      name,
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan", ...args },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", ...expected });
  });

  it("caps an explicit extension length on a video-extend model", async () => {
    const { model, fetch, submitted } = atlasVideoModel(
      {
        video: { type: "string" },
        duration: { type: "integer", default: 15, minimum: 1, maximum: 20 },
        generate_audio: { type: "boolean", default: true },
      },
      ["prompt"],
      "vendor/test-video-extend",
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "continue" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "continue", duration: 10, generate_audio: false });
  });

  it("accepts Atlas size and dimension defaults within the allowlist", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 5 },
      size: { type: "string", default: "1920*1080" },
      height: { type: "integer", default: 1080 },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 5 });
  });

  it("sends the cap on Atlas Cloud when the schema default is longer", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      duration: { type: "integer", default: 12 },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 10 });
  });

  it("sends an Atlas schema default within the cap, and the server default when there is none", async () => {
    const withDefault = atlasVideoModel({ duration: { type: "integer", default: 8 } });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: withDefault.model, prompt: "pan" },
      { fetch: withDefault.fetch },
    );
    expect(withDefault.submitted()).toMatchObject({ duration: 8 });

    const noDefault = atlasVideoModel({ duration: { type: "number" } });
    await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model: noDefault.model, prompt: "pan" },
      { fetch: noDefault.fetch },
    );
    expect(noDefault.submitted()).toMatchObject({ duration: 5 });
  });

  it("caps Atlas length fields with other names, snapping to the largest enum value within the cap", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      seconds: { type: "string", enum: ["4", "8", "12"], default: "12" },
      video_length: { type: "integer", minimum: 2, maximum: 20, default: 15 },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", seconds: "8", video_length: 10 });
  });

  it("maps a requested duration onto the Atlas model's own length field", async () => {
    const { model, fetch, submitted } = atlasVideoModel({
      seconds: { type: "string", enum: ["4", "8", "12"], default: "12" },
    });
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan", duration: 4 },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", seconds: "4" });
  });

  it.each([
    ["a minimum above the cap", { video_length: { type: "integer", minimum: 12, default: 12 } }],
    ["no enum value within the cap", { duration: { type: "integer", enum: [12, 15] } }],
  ])("rejects an Atlas model whose length field has %s before submit", async (_label, props) => {
    const { model, fetch, calls } = atlasVideoModel(props);
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no allowed value within this server's cap of 10s/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    ["a required", ["prompt", "resolution"]],
    ["an optional", ["prompt"]],
  ])(
    "rejects %s Atlas resolution whose schema default is outside the allowlist",
    async (_label, required) => {
      const { model, fetch, calls } = atlasVideoModel(
        {
          duration: { type: "integer", default: 5 },
          resolution: { type: "string", enum: ["720p", "4k"], default: "4k" },
        },
        required,
      );
      const result = await callTool(
        fullEnv(),
        "multix_generate_video",
        { provider: "atlascloud", model, prompt: "pan" },
        { fetch },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/would render at 4k; pass a resolution/);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    },
  );

  it("accepts an Atlas resolution default inside the allowlist", async () => {
    const { model, fetch, submitted } = atlasVideoModel(
      {
        duration: { type: "integer", default: 5 },
        resolution: { type: "string", enum: ["720p", "1080p"], default: "1080p" },
      },
      ["prompt", "resolution"],
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(submitted()).toEqual({ model, prompt: "pan", duration: 5, resolution: "1080p" });
  });

  it("words Atlas field errors for MCP clients, without CLI hints", async () => {
    const { model, fetch } = atlasVideoModel({});
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "atlascloud", model, prompt: "pan", duration: 5 },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not accept duration\. Its inputs: prompt\.$/);
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

  it("reports a Cloudflare network failure as a provider error, not an internal error", async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "cloudflare", prompt: "rain" },
      { fetch },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "HTTP 0 from https://gateway.ai.cloudflare.com/: fetch failed",
    );
  });

  it("accepts HeyGen's 768p resolution by default", async () => {
    const { fetch, calls } = mockFetch(
      route("POST", /\/v3\/models\/videos$/, () =>
        jsonResponse({ data: { video_id: "hg2", status: "pending" } }),
      ),
    );
    const result = await callTool(
      fullEnv(),
      "multix_generate_video",
      { provider: "heygen", prompt: "x", duration: 5, resolution: "768p" },
      { fetch },
    );
    expect(result.isError).toBeFalsy();
    expect(calls[0]?.body).toMatchObject({ resolution: "768p" });
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
        // Shared CLI validation names the tool argument, not the CLI flag.
        expect(result.content[0].text).toMatch(/^duration must be an integer between 5 and 15/);
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
    expect(denied.content[0].text).toMatch(/resolution must be one of 480p, 720p, 768p, 1080p/);
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
