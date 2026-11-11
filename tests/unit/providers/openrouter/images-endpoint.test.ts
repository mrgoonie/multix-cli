import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../../../src/core/errors.js";
import { generateOpenRouterImage } from "../../../../src/providers/openrouter/client.js";
import {
  buildImagesPayload,
  extractImagesFromImagesResponse,
  isImagesEndpointRequired,
} from "../../../../src/providers/openrouter/images-endpoint.js";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const FLARE_404 =
  '{"error":{"message":"openai/gpt-image-2.6-flare is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.","code":404}}';

describe("openrouter /images endpoint", () => {
  it("detects the chat-completions rejection", () => {
    const err = new HttpError(404, FLARE_404, "https://openrouter.ai/api/v1/chat/completions");
    expect(isImagesEndpointRequired(err)).toBe(true);
    expect(isImagesEndpointRequired(new HttpError(404, "no such model", "https://x"))).toBe(false);
    expect(isImagesEndpointRequired(new HttpError(500, FLARE_404, "https://x"))).toBe(false);
  });

  it("builds the payload", () => {
    expect(
      buildImagesPayload({
        prompt: "p",
        model: "m/x",
        aspectRatio: "16:9",
        imageSize: "2K",
        refs: ["data:image/png;base64,AA"],
      }),
    ).toEqual({
      model: "m/x",
      prompt: "p",
      aspect_ratio: "16:9",
      resolution: "2K",
      input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
    });
  });

  it("turns b64_json into data URLs", () => {
    const parsed = extractImagesFromImagesResponse({
      data: [{ b64_json: "QUJD", media_type: "image/webp" }, { b64_json: "" }],
    });
    expect(parsed.urls).toEqual(["data:image/webp;base64,QUJD"]);
  });

  describe("generate fallback", () => {
    const originalFetch = globalThis.fetch;
    let dir: string;
    const prev = { ...process.env };
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-or-"));
      process.env.OPENROUTER_API_KEY = "test-key";
      process.env.MULTIX_OUTPUT_DIR = dir;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
      process.env = { ...prev };
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("retries an image-only model via /api/v1/images", async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        if (url.includes("chat/completions")) return new Response(FLARE_404, { status: 404 });
        return new Response(
          JSON.stringify({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] }),
          {
            status: 200,
          },
        );
      }) as typeof fetch;

      const res = await generateOpenRouterImage({
        prompt: "a cat",
        model: "openai/gpt-image-2.6-flare",
      });
      expect(res.status).toBe("success");
      expect(calls.some((u) => u.endsWith("/api/v1/images"))).toBe(true);
      expect(fs.readFileSync(res.generatedImages?.[0] ?? "").toString()).toBe("fake-png-bytes");
    });
  });
});
