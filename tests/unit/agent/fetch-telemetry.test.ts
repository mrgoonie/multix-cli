/**
 * The CLI fetch wrapper records provider usage with the host that reported it,
 * so a credit number in the envelope always names its source.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFetchTelemetry,
  redactUrlsInText,
  settleTelemetry,
  shorten,
} from "../../../src/agent/fetch-telemetry.js";
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

describe("shorten (dry-run body)", () => {
  it("drops URL query strings and fragments but keeps origin and path", () => {
    const body = {
      model: "openai/gpt-4o-audio",
      input_audio: { url: "https://cdn.example.com/x/talk.m4a?sig=SECRETSIG&exp=1" },
      image_urls: [
        "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=abc",
        "https://r2.example.com/b.png#token=xyz",
        "https://example.com/plain.png",
      ],
      prompt: "describe https://gcs.example.com/c.jpg?GoogleAccessId=g&Signature=s please",
    };
    const out = shorten(body);
    expect(JSON.stringify(out)).not.toMatch(/SECRETSIG|exp=1|abc|xyz|GoogleAccessId|Signature=s/);
    expect(out).toEqual({
      model: "openai/gpt-4o-audio",
      input_audio: { url: "https://cdn.example.com/x/talk.m4a?[redacted]" },
      image_urls: [
        "https://bucket.s3.amazonaws.com/a.png?[redacted]",
        "https://r2.example.com/b.png?[redacted]",
        "https://example.com/plain.png",
      ],
      prompt: "describe https://gcs.example.com/c.jpg?[redacted] please",
    });
  });

  it("redacts URLs whose path holds a quote or space, userinfo, and uppercase schemes", () => {
    const out = shorten({
      a: "https://b.s3.amazonaws.com/John's.png?X-Amz-Signature=LEAK1",
      b: "https://cdn.example.com/my photo.png?sig=LEAK2",
      c: "see https://x.com/a.png?sig=abc'LEAK3 now",
      d: "https://user:LEAK4@x.com/a.png",
      e: "HTTPS://X.COM/a.png?sig=LEAK5",
    });
    expect(JSON.stringify(out)).not.toMatch(/LEAK/);
    expect(out).toMatchObject({
      a: "https://b.s3.amazonaws.com/John's.png?[redacted]",
      b: "https://cdn.example.com/my%20photo.png?[redacted]",
      c: "see https://x.com/a.png?[redacted] now",
      d: "https://x.com/a.png",
    });
  });
});

describe("redactUrlsInText", () => {
  it("leaves text without signed URLs unchanged", () => {
    expect(redactUrlsInText("a cat at https://example.com/a.png")).toBe(
      "a cat at https://example.com/a.png",
    );
  });
});
