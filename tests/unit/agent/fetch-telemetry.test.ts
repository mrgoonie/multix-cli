/**
 * The CLI fetch wrapper records provider usage with the host that reported it,
 * so a credit number in the envelope always names its source.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFetchTelemetry, settleTelemetry } from "../../../src/agent/fetch-telemetry.js";
import { run } from "../../../src/agent/run-state.js";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  run.postUsage = [];
  run.calls = [];
  run.ids = [];
  run.requestModel = undefined;
});

describe("installFetchTelemetry", () => {
  it("prefixes usage sources with the responding host", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "character-cost": "5" },
        }),
    ) as typeof fetch;
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    await fetch("https://api.elevenlabs.io/v1/text-to-speech/v", {
      method: "POST",
      body: JSON.stringify({ text: "Hi", model_id: "eleven_v4" }),
    });
    await settleTelemetry();
    expect(run.requestModel).toBe("eleven_v4");
    expect(run.postUsage).toHaveLength(1);
    expect(run.postUsage[0]?.credits).toBe(5);
    expect(run.postUsage[0]?.sources).toEqual({
      credits: "api.elevenlabs.io header.character-cost",
    });
  });
});

describe("dry-run request body", () => {
  async function dryRunBody(body: unknown): Promise<unknown> {
    return dryRun(body instanceof FormData ? body : JSON.stringify(body));
  }

  async function dryRun(body: BodyInit): Promise<unknown> {
    globalThis.fetch = vi.fn() as typeof fetch;
    let captured: unknown;
    run.dryRun = true;
    try {
      installFetchTelemetry((request) => {
        captured = request.body;
        throw new Error("dry run stop");
      });
      await expect(
        fetch("https://api.example.com/v1/run?key=abc", {
          method: "POST",
          body,
        }),
      ).rejects.toThrow("dry run stop");
    } finally {
      run.dryRun = false;
    }
    return captured;
  }

  it("redacts query strings of nested and listed URLs but keeps origin and path", async () => {
    const body = await dryRunBody({
      model: "m",
      input_audio: { url: "https://cdn.example.com/x/talk.m4a?sig=SECRETSIG", format: "m4a" },
      image_urls: [
        "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=SECRETA",
        "https://storage.googleapis.com/b/c.jpg?X-Goog-Signature=SECRETB#frag",
        "https://user:SECRETPW@example.com/plain.png",
        "https://example.com/no-query.png",
      ],
      prompt: "a cat",
    });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/SECRET/);
    expect(body).toEqual({
      model: "m",
      input_audio: { url: "https://cdn.example.com/x/talk.m4a?[redacted]", format: "m4a" },
      image_urls: [
        "https://bucket.s3.amazonaws.com/a.png?[redacted]",
        "https://storage.googleapis.com/b/c.jpg?[redacted]",
        "https://example.com/plain.png",
        "https://example.com/no-query.png",
      ],
      prompt: "a cat",
    });
  });

  it("keeps the path of a long signed URL instead of hiding it entirely", async () => {
    const url = `https://r2.example.com/out/v.mp4?sig=${"S".repeat(600)}`;
    expect(await dryRunBody({ video_url: url })).toEqual({
      video_url: "https://r2.example.com/out/v.mp4?[redacted]",
    });
  });

  it("redacts signed URLs in multipart fields and inside longer text", async () => {
    const form = new FormData();
    form.append("image_url", "https://b.s3.amazonaws.com/a.png?X-Amz-Signature=SECRETF");
    form.append("prompt", "Describe https://cdn.example.com/p.jpg?token=SECRETT please");
    expect(await dryRunBody(form)).toEqual({
      image_url: "https://b.s3.amazonaws.com/a.png?[redacted]",
      prompt: "Describe https://cdn.example.com/p.jpg?[redacted] please",
    });
  });
});
