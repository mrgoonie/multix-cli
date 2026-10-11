import { describe, expect, it, vi } from "vitest";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { HeygenClient, unwrapData } from "../../../../src/providers/heygen/client.js";
import { HeygenApiError } from "../../../../src/providers/heygen/heygen-errors.js";
import { type FakeReply, fakeHeygen, noSleep } from "./fake-heygen.js";

const BASE = "https://api.heygen.test";
const KEY = "hg-secret-key-123";

function client(routes: Record<string, FakeReply | FakeReply[]>, extra = {}) {
  const fake = fakeHeygen(routes);
  let n = 0;
  const c = new HeygenClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep: noSleep,
    newIdempotencyKey: () => `idem-${++n}`,
    ...extra,
  });
  return { c, fake };
}

describe("HeygenClient construction and auth", () => {
  it("rejects an empty API key", () => {
    expect(() => new HeygenClient({ apiKey: "  " })).toThrow(ValidationError);
  });

  it("sends X-Api-Key (not Bearer) and unwraps { data }", async () => {
    const { c, fake } = client({
      "GET /v3/users/me": { body: { data: { username: "duy", email: "a@b.c" } } },
    });
    const me = await c.getCurrentUser();
    expect(me).toMatchObject({ username: "duy" });
    const call = fake.calls[0];
    expect(call?.url).toBe(`${BASE}/v3/users/me`);
    expect(call?.headers["x-api-key"]).toBe(KEY);
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.headers["idempotency-key"]).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl and encodes path IDs", async () => {
    const { c, fake } = client(
      { "GET /v3/videos/a%2Fb": { body: { data: { id: "a/b", status: "pending" } } } },
      { baseUrl: `${BASE}///` },
    );
    await c.getVideo("a/b");
    expect(fake.calls[0]?.url).toBe(`${BASE}/v3/videos/a%2Fb`);
  });

  it("rejects empty path IDs before any request", async () => {
    const { c, fake } = client({});
    await expect(async () => c.getVideo(" ")).rejects.toThrow(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("unwrapData", () => {
  it("rejects error bodies and missing data", () => {
    expect(() => unwrapData({ error: { code: "x", message: "boom" } }, "/p")).toThrow(/boom/);
    expect(() => unwrapData({}, "/p")).toThrow(ProviderError);
    expect(() => unwrapData(null, "/p")).toThrow(ProviderError);
    expect(unwrapData({ data: { a: 1 } }, "/p")).toEqual({ a: 1 });
  });
});

describe("Idempotency-Key", () => {
  it("is sent on POST /v3/videos and omitted on POST /v3/video-agents", async () => {
    const { c, fake } = client({
      "POST /v3/videos": { body: { data: { video_id: "v1", status: "waiting" } } },
      "POST /v3/video-agents": { body: { data: { session_id: "s1", status: "thinking" } } },
    });
    await c.createVideo({ type: "avatar", avatar_id: "look", script: "hi" });
    await c.createVideoAgent({ prompt: "make a video" });
    expect(fake.callsTo("POST /v3/videos")[0]?.headers["idempotency-key"]).toBe("idem-1");
    expect(fake.callsTo("POST /v3/video-agents")[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("is sent on translations, lipsyncs, templates and model videos", async () => {
    const { c, fake } = client({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1"] } } },
      "POST /v3/lipsyncs": { body: { data: { lipsync_id: "l1" } } },
      "POST /v3/templates/tpl": { body: { data: { id: "v9", status: "pending" } } },
      "POST /v3/models/videos": { body: { data: { video_id: "m1", status: "pending" } } },
    });
    await c.createVideoTranslation({
      video: { type: "url", url: "https://x.test/a.mp4" },
      output_languages: ["Spanish"],
    });
    await c.createLipsync({
      video: { type: "url", url: "https://x.test/a.mp4" },
      audio: { type: "url", url: "https://x.test/a.mp3" },
    });
    await c.generateFromTemplate("tpl", { variables: {} });
    await c.createModelVideo({ model: "heygen-video-1", mode: "text_to_video", prompt: "x" });
    for (const call of fake.calls) expect(call.headers["idempotency-key"]).toMatch(/^idem-/);
  });
});

describe("pagination", () => {
  it("maps has_more/next_token and forwards token/limit/filters", async () => {
    const { c, fake } = client({
      "GET /v3/avatars/looks": [
        { body: { data: [{ id: "l1" }, { id: "l2" }], has_more: true, next_token: "tok2" } },
        { body: { data: [{ id: "l3" }], has_more: false, next_token: null } },
      ],
      "GET /v3/voices": { body: { data: [{ voice_id: "v1" }], has_more: false } },
    });
    const p1 = await c.listAvatarLooks({ limit: 2, avatar_type: "photo_avatar" });
    expect(p1).toEqual({ items: [{ id: "l1" }, { id: "l2" }], hasMore: true, nextToken: "tok2" });
    const p2 = await c.listAvatarLooks({ limit: 2, token: "tok2" });
    expect(p2.hasMore).toBe(false);
    expect(p2.nextToken).toBeNull();
    const q1 = fake.calls[0]?.query;
    expect(q1?.get("limit")).toBe("2");
    expect(q1?.get("avatar_type")).toBe("photo_avatar");
    expect(fake.calls[1]?.query.get("token")).toBe("tok2");

    const voices = await c.listVoices({ language: "English", gender: "female" });
    expect(voices.items).toHaveLength(1);
    expect(fake.calls[2]?.query.get("language")).toBe("English");
  });

  it("rejects a non-list data payload", async () => {
    const { c } = client({ "GET /v3/voices": { body: { data: { nope: true } } } });
    await expect(c.listVoices()).rejects.toThrow(/not a list/);
  });
});

describe("error mapping and retries", () => {
  it("maps 401 into an actionable HeygenApiError without leaking the key", async () => {
    const { c } = client({
      "GET /v3/users/me": {
        status: 401,
        body: { error: { code: "unauthorized", message: "Invalid API key" } },
      },
    });
    const err = await c.getCurrentUser().catch((e) => e);
    expect(err).toBeInstanceOf(HeygenApiError);
    expect(err.status).toBe(401);
    expect(err.apiCode).toBe("unauthorized");
    expect(err.message).toMatch(/HEYGEN_API_KEY/);
    expect(err.message).not.toContain(KEY);
  });

  it("explains 402 credit failures and billing separation", async () => {
    const { c } = client({
      "POST /v3/videos": {
        status: 402,
        body: { error: { code: "insufficient_credit", message: "Not enough credits" } },
      },
    });
    const err = await c.createVideo({ type: "avatar" }).catch((e) => e);
    expect(err.message).toMatch(/insufficient_credit/);
    expect(err.message).toMatch(/billed separately/);
  });

  it("does not retry GET requests (polling handles transient errors)", async () => {
    const { c, fake } = client({ "GET /v3/videos/v1": { status: 503, body: {} } });
    await expect(c.getVideo("v1")).rejects.toBeInstanceOf(HeygenApiError);
    expect(fake.calls).toHaveLength(1);
  });

  it("retries a 429 with Retry-After on a create, honouring the delay", async () => {
    const sleep = vi.fn(noSleep);
    const { c, fake } = client(
      {
        "POST /v3/video-agents": [
          {
            status: 429,
            headers: { "Retry-After": "7" },
            body: { error: { code: "rate_limit_exceeded", message: "slow down" } },
          },
          { body: { data: { session_id: "s1", status: "thinking" } } },
        ],
      },
      { sleep },
    );
    const res = await c.createVideoAgent({ prompt: "p" });
    expect(res.session_id).toBe("s1");
    expect(fake.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("does not retry quota_exceeded 429s", async () => {
    const { c, fake } = client({
      "POST /v3/videos": {
        status: 429,
        headers: { "Retry-After": "1" },
        body: { error: { code: "quota_exceeded", message: "quota" } },
      },
    });
    const err = await c.createVideo({ type: "avatar" }).catch((e) => e);
    expect(err.message).toMatch(/quota/i);
    expect(fake.calls).toHaveLength(1);
  });

  it("retries 5xx only when an Idempotency-Key makes replay safe, reusing the same key", async () => {
    const { c, fake } = client({
      "POST /v3/videos": [
        { status: 502, body: {} },
        { body: { data: { video_id: "v1", status: "waiting" } } },
      ],
      "POST /v3/video-agents": { status: 502, body: {} },
    });
    expect((await c.createVideo({ type: "avatar" })).video_id).toBe("v1");
    const videoCalls = fake.callsTo("POST /v3/videos");
    expect(videoCalls).toHaveLength(2);
    expect(videoCalls[0]?.headers["idempotency-key"]).toBe(
      videoCalls[1]?.headers["idempotency-key"],
    );

    await expect(c.createVideoAgent({ prompt: "p" })).rejects.toBeInstanceOf(HeygenApiError);
    expect(fake.callsTo("POST /v3/video-agents")).toHaveLength(1);
  });

  it("stops after maxAttempts", async () => {
    const { c, fake } = client(
      { "POST /v3/videos": { status: 500, body: {} } },
      { maxAttempts: 2 },
    );
    await expect(c.createVideo({ type: "avatar" })).rejects.toBeInstanceOf(HeygenApiError);
    expect(fake.calls).toHaveLength(2);
  });

  it("does not retry 4xx validation errors", async () => {
    const { c, fake } = client({
      "POST /v3/videos": {
        status: 400,
        body: { error: { code: "invalid_parameter", message: "bad", param: "avatar_id" } },
      },
    });
    const err = await c.createVideo({ type: "avatar" }).catch((e) => e);
    expect(err.message).toMatch(/param: avatar_id/);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("listTranslationLanguages", () => {
  it("returns language names", async () => {
    const { c } = client({
      "GET /v3/video-translations/languages": {
        body: { data: { languages: ["English", "Chinese (Cantonese, Traditional)"] } },
      },
    });
    expect(await c.listTranslationLanguages()).toContain("Chinese (Cantonese, Traditional)");
  });
});

describe("uploadAsset", () => {
  it("sends multipart with a file field and an Idempotency-Key", async () => {
    const { c, fake } = client({
      "POST /v3/assets": {
        body: {
          data: {
            asset_id: "as1",
            url: "https://x.test/a.png",
            mime_type: "image/png",
            size_bytes: 3,
          },
        },
      },
    });
    const res = await c.uploadAsset({
      data: new Uint8Array([1, 2, 3]),
      filename: "a.png",
      mimeType: "image/png",
    });
    expect(res.asset_id).toBe("as1");
    const call = fake.calls[0];
    expect(call?.headers["x-api-key"]).toBe(KEY);
    expect(call?.headers["idempotency-key"]).toBe("idem-1");
    // Content-Type must be left to fetch so the multipart boundary is set.
    expect(call?.headers["content-type"]).toBeUndefined();
    const form = call?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("a.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("accepts a Blob", async () => {
    const { c } = client({
      "POST /v3/assets": { body: { data: { asset_id: "as2" } } },
    });
    const res = await c.uploadAsset({
      data: new Blob(["abc"], { type: "audio/mpeg" }),
      filename: "a.mp3",
      mimeType: "audio/mpeg",
    });
    expect(res.asset_id).toBe("as2");
  });

  it("rejects empty and oversized files before uploading", async () => {
    const { c, fake } = client({});
    await expect(
      c.uploadAsset({ data: new Uint8Array(0), filename: "e.png", mimeType: "image/png" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      c.uploadAsset({
        data: new Uint8Array(32 * 1024 * 1024 + 1),
        filename: "big.mp4",
        mimeType: "video/mp4",
      }),
    ).rejects.toThrow(/32 MB/);
    expect(fake.calls).toHaveLength(0);
  });

  it("retries a 5xx upload with the same key and surfaces API errors", async () => {
    const { c, fake } = client({
      "POST /v3/assets": [
        { status: 503, body: {} },
        { status: 413, body: { error: { code: "file_too_large", message: "too big" } } },
      ],
    });
    const err = await c
      .uploadAsset({ data: new Uint8Array([1]), filename: "a.png", mimeType: "image/png" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HeygenApiError);
    expect(err.message).toMatch(/too big/);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.headers["idempotency-key"]).toBe(
      fake.calls[1]?.headers["idempotency-key"],
    );
  });
});
