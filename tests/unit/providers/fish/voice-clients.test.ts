/**
 * Fish Audio voice design, clone and delete clients with an injected fetch:
 * one POST and never a retry, the voice-design model header, base64 and
 * candidate checks, the clone multipart form, unknown remote states and the
 * shared gateway handling of postFishOnce. No network.
 */

import { describe, expect, it } from "vitest";
import { HttpError } from "../../../../src/core/errors.js";
import {
  decodeBase64Audio,
  designFishVoice,
} from "../../../../src/providers/fish/voice-design-client.js";
import {
  cloneForm,
  createFishClone,
  deleteFishVoice,
  fishModelId,
} from "../../../../src/providers/fish/voices-client.js";

const KEY = "fish-SECRET-KEY-VALUE";
const VOICE = "a".repeat(32);

function wav(sampleRate: number, dataBytes: number): Uint8Array {
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fetchReturning(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    seen.push(s);
    return respond(s);
  };
  return { fetch, seen };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("fish voice design client", () => {
  it("decodes strict base64 and refuses junk or oversized audio", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(decodeBase64Audio(b64(bytes), 100, "c0")).toEqual(bytes);
    expect(() => decodeBase64Audio("not base64!", 100, "c0")).toThrow(/invalid base64/);
    expect(() => decodeBase64Audio("abc", 100, "c0")).toThrow(/invalid base64/);
    expect(() => decodeBase64Audio(b64(new Uint8Array(200)), 100, "c0")).toThrow(/limit/);
  });

  it("posts once with the voice-design-1 header, reports the billed request and checks each WAV", async () => {
    const audio = wav(44_100, 88_200);
    const { fetch, seen } = fetchReturning(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                id: "c-1",
                index: 0,
                audio_base64: b64(audio),
                sample_rate: 44_100,
                duration_ms: 1000,
                signature: "sig-1",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    let accepted = 0;
    const out = await designFishVoice({
      body: { instruction: "Warm narrator", n: 1 },
      apiKey: KEY,
      maxBytes: 1024 * 1024,
      fetch,
      onAccepted: () => accepted++,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.fish.audio/v1/voice-design");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("model")).toBe("voice-design-1");
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ instruction: "Warm narrator", n: 1 });
    expect(accepted).toBe(1);
    expect(out[0]).toMatchObject({ id: "c-1", index: 0, signature: "sig-1" });
    expect(out[0]?.check).toMatchObject({ kind: "wav", signature_ok: true, duration_s: 1 });
  });

  it("checks the request before sending it", async () => {
    const { fetch, seen } = fetchReturning(() => new Response("{}"));
    const send = (body: Parameters<typeof designFishVoice>[0]["body"]) =>
      designFishVoice({ body, apiKey: KEY, maxBytes: 1, fetch });
    await expect(send({ instruction: "x", n: 5 })).rejects.toThrow(/--count/);
    await expect(send({ instruction: "  " })).rejects.toThrow(/1-2000/);
    await expect(send({ instruction: "x", speed: 4 })).rejects.toThrow(/--speed/);
    await expect(send({ instruction: "x", language: "en us" })).rejects.toThrow(/--language/);
    await expect(send({ instruction: "x", reference_text: "a".repeat(301) })).rejects.toThrow(
      /--reference-text/,
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an answer without candidates or with broken base64, after counting the charge", async () => {
    for (const body of [
      { candidates: [] },
      { candidates: [{ index: 0, audio_base64: "%%%" }] },
      { candidates: [{ index: 0 }] },
    ]) {
      const { fetch } = fetchReturning(() => new Response(JSON.stringify(body)));
      let accepted = 0;
      await expect(
        designFishVoice({
          body: { instruction: "x" },
          apiKey: KEY,
          maxBytes: 1024,
          fetch,
          onAccepted: () => accepted++,
        }),
      ).rejects.toThrow(/no candidates|invalid base64|has no audio/);
      expect(accepted).toBe(1);
    }
  });

  it("does not count Fish's own error answer as billed and never retries it", async () => {
    const { fetch, seen } = fetchReturning(
      () =>
        new Response(JSON.stringify({ status: 402, message: "Insufficient balance" }), {
          status: 402,
        }),
    );
    let accepted = 0;
    const err = await designFishVoice({
      body: { instruction: "x" },
      apiKey: KEY,
      maxBytes: 1024,
      fetch,
      onAccepted: () => accepted++,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toMatch(/Insufficient balance/);
    expect(err.message).not.toContain(KEY);
    expect(accepted).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("reports an unknown remote state for a gateway page, a 408 or a dropped line", async () => {
    const answers: Array<() => Response> = [
      () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      () => new Response("Request Timeout", { status: 408 }),
      () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      },
    ];
    for (const answer of answers) {
      const { fetch, seen } = fetchReturning(answer);
      const err = await designFishVoice({
        body: { instruction: "x" },
        apiKey: KEY,
        maxBytes: 1024,
        fetch,
      }).catch((e) => e);
      expect(err.code).toBe("UNKNOWN_REMOTE_STATE");
      expect(err.message).toMatch(/voice design.*may be billed/);
      expect(seen).toHaveLength(1);
    }
  });
});

describe("fish voice clone and delete clients", () => {
  const sample = { name: "a.wav", data: new Blob([wav(16_000, 320)]) };

  it("builds a private fast tts form and refuses partial transcripts or signatures", () => {
    const form = cloneForm({ apiKey: KEY, title: " Me ", samples: [sample, sample] });
    expect(form.get("type")).toBe("tts");
    expect(form.get("train_mode")).toBe("fast");
    expect(form.get("visibility")).toBe("private");
    expect(form.get("title")).toBe("Me");
    expect(form.getAll("voices")).toHaveLength(2);
    expect(form.getAll("texts")).toHaveLength(0);
    expect(form.get("enhance_audio_quality")).toBeNull();
    const full = cloneForm({
      apiKey: KEY,
      title: "Me",
      samples: [{ ...sample, text: "xin chào" }],
      visibility: "unlist",
      tags: ["vi", "narrator"],
      enhanceAudioQuality: false,
      designSignatures: ["sig-1"],
    });
    expect(full.getAll("texts")).toEqual(["xin chào"]);
    expect(full.get("visibility")).toBe("unlist");
    expect(full.getAll("tags")).toEqual(["vi", "narrator"]);
    expect(full.get("enhance_audio_quality")).toBe("false");
    expect(full.getAll("voice_design_signatures")).toEqual(["sig-1"]);
    expect(() =>
      cloneForm({ apiKey: KEY, title: "Me", samples: [{ ...sample, text: "hi" }, sample] }),
    ).toThrow(/every sample, or for none/);
    expect(() =>
      cloneForm({ apiKey: KEY, title: "Me", samples: [sample], designSignatures: ["a", "b"] }),
    ).toThrow(/one --design-signature per sample/);
    expect(() => cloneForm({ apiKey: KEY, title: "Me", samples: [] })).toThrow(/1-20/);
    expect(() => cloneForm({ apiKey: KEY, title: " ", samples: [sample] })).toThrow(/--title/);
  });

  it("creates the voice with one multipart POST and reports an unknown state on a dropped line", async () => {
    const ok = fetchReturning(
      () => new Response(JSON.stringify({ _id: VOICE, title: "Me", state: "trained" })),
    );
    const voice = await createFishClone({
      apiKey: KEY,
      title: "Me",
      samples: [sample],
      fetch: ok.fetch,
    });
    expect(voice).toMatchObject({ id: VOICE, title: "Me", state: "trained" });
    expect(ok.seen).toHaveLength(1);
    expect(ok.seen[0]?.url).toBe("https://api.fish.audio/model");
    expect(ok.seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(ok.seen[0]?.body).toBeInstanceOf(FormData);

    const dropped = fetchReturning(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    const err = await createFishClone({
      apiKey: KEY,
      title: "Me",
      samples: [sample],
      fetch: dropped.fetch,
    }).catch((e) => e);
    expect(err.code).toBe("UNKNOWN_REMOTE_STATE");
    expect(err.message).toMatch(/fish voices list/);
    expect(dropped.seen).toHaveLength(1);
  });

  it("treats an accepted clone with an unreadable answer as an unknown state, not an error to retry", async () => {
    for (const body of ["<html>ok</html>", JSON.stringify({ title: "Me" })]) {
      const { fetch } = fetchReturning(() => new Response(body, { status: 201 }));
      const err = await createFishClone({
        apiKey: KEY,
        title: "Me",
        samples: [sample],
        fetch,
      }).catch((e) => e);
      expect(err.code).toBe("UNKNOWN_REMOTE_STATE");
      expect(err.message).toMatch(/fish voices list/);
    }
  });

  it("deletes by id with one DELETE and refuses an id that could change the path", async () => {
    const { fetch, seen } = fetchReturning(() => new Response(null, { status: 200 }));
    await deleteFishVoice({ apiKey: KEY, id: VOICE, fetch });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe(`https://api.fish.audio/model/${VOICE}`);
    expect(fishModelId(` ${VOICE} `)).toBe(VOICE);
    expect(() => fishModelId("../etc")).toThrow(/not a Fish Audio voice id/);
    await expect(deleteFishVoice({ apiKey: KEY, id: "a/b", fetch })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
