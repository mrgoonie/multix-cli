/**
 * Fish Audio /v1/tts client with an injected fetch: the exact `model` header,
 * one POST and never a retry, and how each failure is reported (HttpError for
 * Fish's own JSON error, UNKNOWN_REMOTE_STATE when the request may have been
 * billed, ProviderError for a 200 without audio). No network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  type MultixError,
  ProviderError,
  ResponseTooLargeError,
  ValidationError,
} from "../../../../src/core/errors.js";
import type { FishTtsModel } from "../../../../src/providers/fish/models.js";
import { createFishSpeech } from "../../../../src/providers/fish/tts-client.js";

const KEY = "fish-SECRET-KEY";
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);

function fetchReturning(make: () => Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => make());
}

const speak = (fetch: ReturnType<typeof fetchReturning>, over: Record<string, unknown> = {}) =>
  createFishSpeech({
    apiKey: KEY,
    model: "drama-3",
    body: { text: "Hi", format: "mp3" },
    maxBytes: 1024,
    fetch,
    ...over,
  });

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

describe("createFishSpeech", () => {
  it("posts once with the exact model header and returns the audio", async () => {
    const fetch = fetchReturning(
      () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } }),
    );
    const result = await speak(fetch, { model: "s2.1-pro" });
    expect(result).toEqual({ audio: MP3, mime: "audio/mpeg", modelHeaderSent: "s2.1-pro" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("model")).toBe("s2.1-pro");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Hi", format: "mp3" });
  });

  it("sends nothing for a model outside the allowlist", async () => {
    const fetch = fetchReturning(() => new Response(MP3));
    await expect(speak(fetch, { model: "drama3" as FishTtsModel })).rejects.toThrow(
      ValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports Fish's JSON error as an HttpError, without retrying", async () => {
    const fetch = fetchReturning(
      () =>
        new Response(JSON.stringify({ status: 402, message: "Insufficient balance" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await errorCode(speak(fetch));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(402);
    expect((err as HttpError).message).toMatch(/Insufficient balance/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a gateway 5xx page as unknown remote state, and a JSON 5xx as an HttpError", async () => {
    const html = fetchReturning(
      () =>
        new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    const unknown = await errorCode(speak(html));
    expect((unknown as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect((unknown as Error).message).toMatch(/may be billed/);
    expect(html).toHaveBeenCalledTimes(1);

    const json = fetchReturning(
      () => new Response(JSON.stringify({ status: 500, message: "boom" }), { status: 500 }),
    );
    expect(await errorCode(speak(json))).toBeInstanceOf(HttpError);
  });

  it("refuses a 200 that carries JSON instead of audio, or no bytes", async () => {
    const json = fetchReturning(
      () =>
        new Response(JSON.stringify({ message: "queued" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await errorCode(speak(json))).toBeInstanceOf(ProviderError);
    const empty = fetchReturning(
      () => new Response(new Uint8Array(0), { headers: { "content-type": "audio/mpeg" } }),
    );
    await expect(speak(empty)).rejects.toThrow(/0 bytes/);
  });

  it("stops past maxBytes and says the generation is still billed", async () => {
    const fetch = fetchReturning(() => new Response(new Uint8Array(4096)));
    const err = await errorCode(speak(fetch, { maxBytes: 100 }));
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as Error).message).toMatch(/still billed/);
  });

  it("reports a broken audio stream as unknown remote state", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(MP3);
        controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      },
    });
    const fetch = fetchReturning(() => new Response(body));
    const err = await errorCode(speak(fetch));
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("tells a request that never left apart from one cut off after it may have arrived", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const notSent = await errorCode(speak(refused as never));
    expect((notSent as MultixError).code).not.toBe("UNKNOWN_REMOTE_STATE");

    const reset = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    const cut = await errorCode(speak(reset as never));
    expect((cut as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never puts the key in an error message", async () => {
    const fetch = fetchReturning(
      () => new Response(JSON.stringify({ message: "Invalid api key" }), { status: 401 }),
    );
    const err = await errorCode(speak(fetch));
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it("names the field of a validation error without echoing the text sent", async () => {
    const fetch = fetchReturning(
      () =>
        new Response(
          JSON.stringify({
            detail: [{ loc: ["body", "text"], msg: "too long", input: "PRIVATE PROMPT" }],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const err = await errorCode(speak(fetch));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toMatch(/body\.text: too long/);
    expect((err as Error).message).not.toContain("PRIVATE PROMPT");
  });
});
