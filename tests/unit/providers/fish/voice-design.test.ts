/**
 * Fish Audio /v1/voice-design client with an injected fetch: the body is
 * validated before anything is sent, the exact `model: voice-design-1`
 * header, one POST and never a retry, strict base64 decoding under a cap, a
 * broken candidate kept apart from good ones, and how each failure is
 * reported (HttpError for Fish's own JSON error, UNKNOWN_REMOTE_STATE when
 * the request may have been billed, ProviderError for no candidates). No network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  type MultixError,
  ProviderError,
  ResponseTooLargeError,
  ValidationError,
} from "../../../../src/core/errors.js";
import {
  createFishVoiceDesign,
  decodeFishBase64,
  planFishVoiceDesign,
} from "../../../../src/providers/fish/voice-design.js";

const KEY = "fish-SECRET-KEY";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const WAV = new Uint8Array([...[0x52, 0x49, 0x46, 0x46], 0, 0, 0, 0, ...[0x57, 0x41, 0x56, 0x45]]);

function fetchReturning(make: () => Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => make());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const design = (fetch: ReturnType<typeof fetchReturning>, over: Record<string, unknown> = {}) =>
  createFishVoiceDesign({
    apiKey: KEY,
    body: { instruction: "Warm narrator", n: 2 },
    maxBytes: 64 * 1024,
    maxCandidateBytes: 1024,
    fetch,
    ...over,
  });

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as MultixError;
  }
  throw new Error("expected a rejection");
};

describe("planFishVoiceDesign", () => {
  it("maps the options to the exact body and nothing else", () => {
    expect(
      planFishVoiceDesign({
        instruction: "  Warm narrator  ",
        referenceText: "Welcome to Fish Audio.",
        language: "en",
        count: 4,
        speed: 1.5,
        numStep: 32,
        guidanceScale: 2,
        instructGuidanceScale: 0,
        seed: 42,
      }),
    ).toEqual({
      instruction: "Warm narrator",
      reference_text: "Welcome to Fish Audio.",
      language: "en",
      n: 4,
      speed: 1.5,
      num_step: 32,
      guidance_scale: 2,
      instruct_guidance_scale: 0,
      seed: 42,
    });
    expect(planFishVoiceDesign({ instruction: "x" })).toEqual({ instruction: "x" });
  });

  it.each([
    [{ instruction: " " }, "--instruction must be 1 to 2000"],
    [{ instruction: "a".repeat(2001) }, "--instruction must be 1 to 2000"],
    [{ instruction: "x", referenceText: "a".repeat(301) }, "--reference-text must be 1 to 300"],
    [{ instruction: "x", count: 5 }, "--count must be a whole number from 1 to 4"],
    [{ instruction: "x", count: 0 }, "--count"],
    [{ instruction: "x", speed: 0 }, "--speed must be above 0"],
    [{ instruction: "x", speed: 3.1 }, "--speed"],
    [{ instruction: "x", numStep: 129 }, "--num-step"],
    [{ instruction: "x", numStep: 1.5 }, "--num-step"],
    [{ instruction: "x", guidanceScale: -1 }, "--guidance-scale"],
    [{ instruction: "x", instructGuidanceScale: -0.1 }, "--instruct-guidance-scale"],
    [{ instruction: "x", seed: 1.5 }, "--seed"],
    [{ instruction: "x", language: "en us" }, "--language"],
  ])("rejects %j", (input, message) => {
    expect(() => planFishVoiceDesign(input)).toThrow(ValidationError);
    expect(() => planFishVoiceDesign(input)).toThrow(message);
  });
});

describe("decodeFishBase64", () => {
  it("decodes standard base64 and a data URL", () => {
    expect([...decodeFishBase64(b64(WAV), 100)]).toEqual([...WAV]);
    expect([...decodeFishBase64(`data:audio/wav;base64,${b64(WAV)}`, 100)]).toEqual([...WAV]);
  });

  it("rejects malformed base64 and checks the size before decoding", () => {
    expect(() => decodeFishBase64("abc", 100)).toThrow("not valid base64");
    expect(() => decodeFishBase64("ab$=", 100)).toThrow("not valid base64");
    expect(() => decodeFishBase64("", 100)).toThrow("not valid base64");
    expect(() => decodeFishBase64("A".repeat(4000), 100)).toThrow("larger than 100 bytes");
  });
});

describe("createFishVoiceDesign", () => {
  it("posts once with the voice-design-1 header and decodes every candidate", async () => {
    const fetch = fetchReturning(() =>
      json({
        candidates: [
          { id: "c0", index: 0, audio_base64: b64(WAV), sample_rate: 24000, duration_ms: 1500 },
          {
            id: "c1",
            index: 1,
            audio_base64: b64(WAV),
            sample_rate: 24000,
            duration_ms: 900,
            text: "Hi",
            language: "en",
          },
        ],
      }),
    );
    const result = await design(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.fish.audio/v1/voice-design");
    const headers = new Headers(init?.headers);
    expect(headers.get("model")).toBe("voice-design-1");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ instruction: "Warm narrator", n: 2 });
    expect(result.modelHeaderSent).toBe("voice-design-1");
    expect(result.candidates).toHaveLength(2);
    expect([...(result.candidates[0]?.audio ?? [])]).toEqual([...WAV]);
    expect(result.candidates[1]).toMatchObject({
      id: "c1",
      index: 1,
      sample_rate: 24000,
      duration_ms: 900,
      text: "Hi",
      language: "en",
      problem: null,
    });
  });

  it("keeps good candidates when another has broken or oversized audio", async () => {
    const fetch = fetchReturning(() =>
      json({
        candidates: [
          { id: "ok", index: 0, audio_base64: b64(WAV), sample_rate: 24000, duration_ms: 1 },
          { id: "bad", index: 1, audio_base64: "%%%", sample_rate: 24000, duration_ms: 1 },
          { id: "big", index: 2, audio_base64: "A".repeat(4000), sample_rate: 1, duration_ms: 1 },
          { id: "none", index: 3, sample_rate: 1, duration_ms: 1 },
        ],
      }),
    );
    const { candidates } = await design(fetch);
    expect(candidates.map((c) => [c.id, c.audio !== null, c.problem])).toEqual([
      ["ok", true, null],
      ["bad", false, "audio_base64 is not valid base64"],
      ["big", false, "decoded audio is larger than 1024 bytes"],
      ["none", false, "no audio_base64"],
    ]);
  });

  it("reports an empty candidate list as a ProviderError (Fish does not bill it)", async () => {
    const err = await caught(design(fetchReturning(() => json({ candidates: [] }))));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("no candidates");
  });

  it("reports Fish's JSON error as an HttpError and does not retry", async () => {
    const fetch = fetchReturning(() => json({ status: 402, message: "Insufficient balance" }, 402));
    const err = await caught(design(fetch));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toContain("Insufficient balance");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a 5xx Fish JSON error as definite but a gateway page as unknown state", async () => {
    const definite = await caught(
      design(fetchReturning(() => json({ status: 503, message: "busy" }, 503))),
    );
    expect(definite).toBeInstanceOf(HttpError);
    const unknown = await caught(
      design(fetchReturning(() => new Response("<html>502</html>", { status: 502 }))),
    );
    expect(unknown.code).toBe("UNKNOWN_REMOTE_STATE");
    expect(unknown.message).toContain("may be billed");
  });

  it("reports a cut-off 200 body as unknown state", async () => {
    const err = await caught(
      design(fetchReturning(() => new Response('{"candidates":[{"id":', { status: 200 }))),
    );
    expect(err.code).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("reports a body over the cap as too large and still billed", async () => {
    const big = json({ candidates: [{ audio_base64: "A".repeat(2000) }] });
    const err = await caught(
      design(
        fetchReturning(() => big),
        { maxBytes: 100 },
      ),
    );
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err.message).toContain("still billed");
  });

  it("reports a dropped connection as unknown state, without the key", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    const err = await caught(design(fetch as never));
    expect(err.code).toBe("UNKNOWN_REMOTE_STATE");
    expect(err.message).not.toContain(KEY);
  });
});
