/**
 * The CLI fetch wrapper records provider usage with the host that reported it,
 * so a credit number in the envelope always names its source.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DryRunRequest,
  installFetchTelemetry,
  settleTelemetry,
} from "../../../src/agent/fetch-telemetry.js";
import { run, summarizeUsage } from "../../../src/agent/run-state.js";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  run.postUsage = [];
  run.getUsage = new Map();
  run.calls = [];
  run.ids = [];
  run.requestModel = undefined;
  run.dryRun = false;
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

describe("GET usage", () => {
  it("keeps the latest poll when only a per-request header id names the response", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      return new Response(JSON.stringify({ status: "done", usage: { cost_usd: 0.5 } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": `req-${n}` },
      });
    }) as typeof fetch;
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    await fetch("https://api.example.test/v1/tasks/current");
    await fetch("https://api.example.test/v1/tasks/current");
    await settleTelemetry();
    expect(summarizeUsage()?.cost_usd).toBe(0.5);
  });
});

describe("dry-run request body", () => {
  async function dryRunBody(body: BodyInit): Promise<DryRunRequest> {
    const inner = vi.fn();
    globalThis.fetch = inner as unknown as typeof fetch;
    let seen: DryRunRequest | undefined;
    installFetchTelemetry((request) => {
      seen = request;
      throw new Error("dry run stop");
    });
    run.dryRun = true;
    await expect(
      fetch("https://openrouter.ai/api/v1/x?key=k", { method: "POST", body }),
    ).rejects.toThrow("dry run stop");
    expect(inner).not.toHaveBeenCalled();
    if (!seen) throw new Error("onDryRun was not called");
    return seen;
  }

  it("redacts URL query strings in nested values and keeps origin and path", async () => {
    const request = await dryRunBody(
      JSON.stringify({
        model: "m",
        input_audio: { url: "https://cdn.example.com/x/talk.m4a?sig=SECRETSIG", format: "m4a" },
        image_urls: [
          "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=AMZSECRET&X-Amz-Expires=60",
          "http://r2.example.dev/b.jpg?token=R2SECRET#frag",
          "https://plain.example.com/c.png",
        ],
        prompt: "describe https://host.example/p.png?se=2026&sig=INLINESECRET please",
      }),
    );
    const text = JSON.stringify(request);
    for (const secret of ["SECRETSIG", "AMZSECRET", "R2SECRET", "INLINESECRET", "X-Amz-Expires"]) {
      expect(text).not.toContain(secret);
    }
    expect(request.url).toBe("https://openrouter.ai/api/v1/x");
    expect(request.body).toEqual({
      model: "m",
      input_audio: { url: "https://cdn.example.com/x/talk.m4a?[redacted]", format: "m4a" },
      image_urls: [
        "https://bucket.s3.amazonaws.com/a.png?[redacted]",
        "http://r2.example.dev/b.jpg?[redacted]#frag",
        "https://plain.example.com/c.png",
      ],
      prompt: "describe https://host.example/p.png?[redacted] please",
    });
  });

  it("redacts the whole query even when the URL holds quote characters", async () => {
    const request = await dryRunBody(
      JSON.stringify({
        a: "https://cdn.example.com/it's.png?sig=QUOTESECRET",
        b: "https://a.example/x?name=it's&sig=QUOTESECRET2",
      }),
    );
    expect(JSON.stringify(request)).not.toContain("QUOTESECRET");
    expect(request.body).toEqual({
      a: "https://cdn.example.com/it's.png?[redacted]",
      b: "https://a.example/x?[redacted]",
    });
  });

  it("redacts URL query strings in form fields", async () => {
    const form = new FormData();
    form.append("image_url", "https://cdn.example.com/a.png?sig=FORMSECRET");
    const request = await dryRunBody(form);
    expect(request.body).toEqual({ image_url: "https://cdn.example.com/a.png?[redacted]" });
  });

  it("shows the value of a model-selecting header but never the Authorization value", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    let seen: DryRunRequest | undefined;
    installFetchTelemetry((request) => {
      seen = request;
      throw new Error("dry run stop");
    });
    run.dryRun = true;
    await expect(
      fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: { Authorization: "Bearer FISHSECRET", model: "drama-3" },
        body: JSON.stringify({ text: "Hi", format: "mp3" }),
      }),
    ).rejects.toThrow("dry run stop");
    expect(seen?.headers).toEqual(expect.arrayContaining(["authorization", "model"]));
    expect(seen?.header_values).toEqual({ model: "drama-3" });
    expect(JSON.stringify(seen)).not.toContain("FISHSECRET");
  });
});
