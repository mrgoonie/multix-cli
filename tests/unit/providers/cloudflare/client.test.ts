import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../../../src/core/errors.js";
import {
  createVideoPrediction,
  runCloudflareBytes,
  runCloudflareJson,
} from "../../../../src/providers/cloudflare/client.js";

function configureNative(): void {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-token");
}

describe("Cloudflare client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends native image input without an AI Gateway envelope", async () => {
    configureNative();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { image: "aW1hZ2U=" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      runCloudflareJson("@cf/black-forest-labs/flux-1-schnell", { prompt: "sunset", steps: 4 }),
    ).resolves.toEqual({ image: "aW1hZ2U=" });
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/accounts/account-id/ai/run/@cf/black-forest-labs/flux-1-schnell");
    expect(JSON.parse(String(options.body))).toEqual({ prompt: "sunset", steps: 4 });
  });

  it("uses the documented AI Gateway REST envelope and payload logging default", async () => {
    configureNative();
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway-id");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { image: "aW1hZ2U=" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await runCloudflareJson("@cf/black-forest-labs/flux-1-schnell", { prompt: "sunset" });
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/ai/run");
    expect(JSON.parse(String(options.body))).toEqual({
      model: "@cf/black-forest-labs/flux-1-schnell",
      input: { prompt: "sunset" },
    });
    expect(options.headers).toMatchObject({
      "cf-aig-gateway-id": "gateway-id",
      "cf-aig-collect-log-payload": "false",
    });
  });

  it("accepts binary MPEG audio and safely rejects other response types", async () => {
    configureNative();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    );
    await expect(
      runCloudflareBytes("@cf/myshell-ai/melotts", { prompt: "hello" }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ result: "not-audio" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      runCloudflareBytes("@cf/myshell-ai/melotts", { prompt: "hello" }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("uses separate Replicate and Cloudflare authorization headers for video", async () => {
    configureNative();
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway-id");
    vi.stubEnv("REPLICATE_API_TOKEN", "replicate-token");
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "prediction-id", status: "starting" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(createVideoPrediction({ prompt: "waves" }, false)).resolves.toMatchObject({
      id: "prediction-id",
      status: "starting",
    });
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/replicate/predictions",
    );
    expect(options.headers).toMatchObject({
      Authorization: "Bearer replicate-token",
      "cf-aig-authorization": "Bearer cloudflare-token",
    });
    expect(JSON.parse(String(options.body))).toEqual({
      version: "prunaai/p-video",
      input: { prompt: "waves" },
    });
  });

  it("rejects malformed prediction output before it reaches command logging", async () => {
    configureNative();
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway-id");
    vi.stubEnv("REPLICATE_API_TOKEN", "replicate-token");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ id: "prediction-id", status: "succeeded", output: { signed: "url" } }),
          { status: 200 },
        ),
    );

    await expect(createVideoPrediction({ prompt: "waves" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("does not expose signed URLs in failed video download errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    const { downloadVideo } = await import("../../../../src/providers/cloudflare/client.js");
    await expect(downloadVideo("https://example.test/video?token=secret")).rejects.toThrow(
      "HTTP 404",
    );
    await expect(downloadVideo("https://example.test/video?token=secret")).rejects.not.toThrow(
      "secret",
    );
  });

  it("does not expose signed URLs when the video URL cannot be parsed", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to parse URL from https://example.test/video?token=secret");
    });
    const { downloadVideo } = await import("../../../../src/providers/cloudflare/client.js");
    await expect(downloadVideo("not a URL?token=secret")).rejects.toThrow("could not be started");
    await expect(downloadVideo("not a URL?token=secret")).rejects.not.toThrow("secret");
  });
});
