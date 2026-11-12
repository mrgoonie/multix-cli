import { describe, expect, it, vi } from "vitest";
import { MultixError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { buildFal3dInput } from "../../../../src/providers/fal/commands/three-d.js";
import { WaveSpeedClient, waveOutputUrls } from "../../../../src/providers/wavespeed/client.js";
import { buildWave3dInput } from "../../../../src/providers/wavespeed/commands/index.js";
import {
  WAVESPEED_DEFAULT_3D_MODEL,
  validateWaveModelId,
} from "../../../../src/providers/wavespeed/models.js";

function data(value: unknown): Response {
  return new Response(JSON.stringify({ code: 200, message: "success", data: value }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function makeClient(fetcher: typeof fetch) {
  return new WaveSpeedClient("private-key", "https://api.wavespeed.ai/api/v3", fetcher);
}

describe("WaveSpeedAI 3D input presets", () => {
  it("maps Seed3D image to documented image field", () => {
    expect(
      buildWave3dInput(WAVESPEED_DEFAULT_3D_MODEL, undefined, ["https://example.com/cat.png"]),
    ).toEqual({
      image: "https://example.com/cat.png",
    });
  });

  it("maps Tripo H3.1 text prompts, multiview photos and custom settings", () => {
    const text = buildWave3dInput("tripo3d/h3.1/text-to-3d", "a castle", []);
    expect(text.prompt).toBe("a castle");
    const images = buildWave3dInput("tripo3d/h3.1/multiview-to-3d", undefined, ["a.png", "b.png"], {
      quad: true,
    });
    expect(images).toEqual({ images: ["a.png", "b.png"], quad: true });
  });

  it("allows one image with Meshy multi-image but requires two with Tripo", () => {
    expect(buildWave3dInput("meshy/v7.1/multi-image-to-3d", undefined, ["a.png"]).images).toEqual([
      "a.png",
    ]);
    expect(() => buildWave3dInput("tripo3d/h3.1/multiview-to-3d", undefined, ["a.png"])).toThrow(
      ValidationError,
    );
  });

  it("rejects wrong input counts and model IDs before any upload", () => {
    expect(() => buildWave3dInput(WAVESPEED_DEFAULT_3D_MODEL, "prompt", ["a.png"])).toThrow(
      ValidationError,
    );
    expect(() =>
      buildWave3dInput(WAVESPEED_DEFAULT_3D_MODEL, undefined, ["a.png", "b.png"]),
    ).toThrow(ValidationError);
    expect(() => buildWave3dInput("missing/unknown", undefined, ["a.png"])).toThrow(
      ValidationError,
    );
    expect(() => validateWaveModelId("../../../evil")).toThrow();
  });
});

describe("fal.ai 3D presets", () => {
  it("correctly maps fal Hunyuan and Tripo model-specific input names", () => {
    expect(buildFal3dInput("fal-ai/hunyuan-3d/v3.1/pro/image-to-3d", undefined, ["a.png"])).toEqual(
      { input_image_url: "a.png" },
    );
    expect(buildFal3dInput("tripo3d/h3.1/multiview-to-3d", undefined, ["a.png", "b.png"])).toEqual({
      image_urls: ["a.png", "b.png"],
    });
  });
  it("supports Meshy one-to-four multi-images but not Tripo one-image multiview", () => {
    expect(buildFal3dInput("meshy/v7.1/multi-image-to-3d", undefined, ["a.png"])).toEqual({
      image_urls: ["a.png"],
    });
    expect(() => buildFal3dInput("tripo3d/h3.1/multiview-to-3d", undefined, ["a.png"])).toThrow(
      ValidationError,
    );
  });
  it("rejects a prompt on an image-only endpoint", () => {
    expect(() => buildFal3dInput("hitem3d/hi3d/v3.0/image-to-3d", "prompt", ["a.png"])).toThrow(
      ValidationError,
    );
  });
});

describe("WaveSpeedAI API transport", () => {
  it("submits once with Bearer auth to the exact documented endpoint", async () => {
    const fetcher = vi.fn(async () => data({ id: "pred_abc123", status: "created" }));
    const submitted = await makeClient(fetcher as typeof fetch).submit(
      "bytedance/seed3d-2.0/image-to-3d",
      { image: "https://example.com/cat.png" },
    );
    expect(submitted.id).toBe("pred_abc123");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.wavespeed.ai/api/v3/bytedance/seed3d-2.0/image-to-3d");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer private-key");
  });

  it("does not retry an ambiguous paid submit after network failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("connection lost");
    });
    const err = await makeClient(fetcher as typeof fetch)
      .submit("bytedance/seed3d-2.0/image-to-3d", { image: "x" })
      .catch((error: unknown) => error);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(MultixError);
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("waits for completion by GET only and returns GLB output", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(data({ id: "pred_42", status: "created", outputs: [] }))
      .mockResolvedValueOnce(
        data({
          id: "pred_42",
          status: "completed",
          outputs: ["https://cdn.example.com/model.glb"],
        }),
      );
    const result = await makeClient(fetcher as typeof fetch).wait("pred_42", {
      timeoutMs: 90_000,
      sleep: async () => {},
    });
    expect(result.status).toBe("completed");
    expect(waveOutputUrls(result)).toEqual(["https://cdn.example.com/model.glb"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init.method).toBe("GET");
  });

  it("stops on failed prediction without resubmission", async () => {
    const fetcher = vi.fn(async () =>
      data({ id: "pred_42", status: "failed", error: "unavailable" }),
    );
    await expect(
      makeClient(fetcher as typeof fetch).wait("pred_42", { sleep: async () => {} }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uploads binary without forwarding the API key to signed storage", async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/media/uploads")) {
        return data({
          download_url: "https://cdn.wavespeed.ai/media/image.png",
          upload: {
            url: "https://storage.example.com/signed?token=private",
            method: "PUT",
            headers: { "Content-Type": "image/png", Authorization: "must-not-forward" },
          },
        });
      }
      return new Response(null, { status: 204 });
    });
    const client = makeClient(fetcher as typeof fetch);
    const ticket = await client.uploadTicket("image.png", 3, "image/png");
    const url = await client.uploadBytes(ticket, new Uint8Array([1, 2, 3]));
    expect(url).toBe("https://cdn.wavespeed.ai/media/image.png");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, storageInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(storageInit.method).toBe("PUT");
    expect(storageInit.redirect).toBe("manual");
    expect(JSON.stringify(storageInit.headers).toLowerCase()).not.toContain("authorization");
    expect(JSON.stringify(storageInit.headers)).not.toContain("private-key");
  });

  it("rejects a local/private storage destination before sending any bytes", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetcher as typeof fetch);
    await expect(
      client.uploadBytes(
        {
          download_url: "https://cdn.example.com/model.png",
          upload: { url: "https://127.0.0.1/internal", method: "PUT", headers: {} },
        },
        new Uint8Array([1]),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
