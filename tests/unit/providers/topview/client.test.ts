/**
 * TopView legacy client against a fake API: auth headers (Bearer + Topview-Uid),
 * the { code, result } envelope and its error codes, key scrubbing, the upload
 * flow, every task kind's submit/query endpoint and result normalization,
 * status synonyms, m2v export, polling through transient failures and the
 * resume hint on timeout. No network or paid calls.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { HttpError, ProviderError } from "../../../../src/core/errors.js";
import {
  ORPHAN_HINT,
  TopviewApiError,
  TopviewClient,
  TopviewTaskError,
  assertTaskSucceeded,
  exportsOf,
  normalizeTask,
  unwrapEnvelope,
} from "../../../../src/providers/topview/client.js";
import {
  type LegacyKind,
  isLegacyTerminal,
  normalizeLegacyStatus,
  parseStatusKind,
} from "../../../../src/providers/topview/models.js";
import {
  IMAGE_URL,
  KEY,
  LEGACY_BASE,
  TASK_ID,
  UID,
  UPLOAD_URL,
  VIDEO_URL,
  createFakeTopview,
  envelopeError,
  noSleep,
  ok,
  routeKey,
} from "./fake-topview.js";

function client(routes: Parameters<typeof createFakeTopview>[0]) {
  const fake = createFakeTopview(routes);
  const c = new TopviewClient({
    apiKey: KEY,
    uid: UID,
    baseUrl: LEGACY_BASE,
    fetch: fake.fetch,
    sleep: noSleep,
  });
  return { client: c, calls: fake.calls };
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("TopviewClient requests", () => {
  it("requires both the key and the UID", () => {
    expect(() => new TopviewClient({ apiKey: "", uid: UID })).toThrow(/API key/);
    expect(() => new TopviewClient({ apiKey: KEY, uid: "" })).toThrow(/UID/);
  });

  it("sends Bearer auth and the Topview-Uid header, and the task id as a query", async () => {
    const { client: c, calls } = client({
      "GET /v1/video_avatar/task/query": [ok({ taskId: TASK_ID, status: "running" })],
    });
    const task = await c.getTask("video-avatar", TASK_ID);
    expect(task).toMatchObject({ kind: "video-avatar", taskId: TASK_ID, status: "running" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers["topview-uid"]).toBe(UID);
    expect(calls[0]?.query).toEqual({ taskId: TASK_ID });
  });

  it("rejects an unsafe task id before any request", async () => {
    const { client: c, calls } = client({});
    await expect(c.getTask("m2v", "../etc")).rejects.toThrow(/Invalid TopView task id/);
    expect(calls).toHaveLength(0);
  });
});

describe("envelope and error codes", () => {
  it("accepts code 200 as a string or a number", () => {
    expect(unwrapEnvelope({ code: "200", result: 1 }, "x")).toBe(1);
    expect(unwrapEnvelope({ code: 200, result: 2 }, "x")).toBe(2);
  });

  it("treats a body without a code as malformed", () => {
    expect(() => unwrapEnvelope({ result: 1 }, "x")).toThrow(/missing envelope code/);
  });

  it("names a documented error code", () => {
    const error = (() => {
      try {
        unwrapEnvelope({ code: "4004", message: "not here" }, "the task");
      } catch (e) {
        return e as TopviewApiError;
      }
    })();
    expect(error).toBeInstanceOf(TopviewApiError);
    expect(error?.apiCode).toBe("4004");
    expect(error?.message).toContain("code 4004: resource not found — not here");
  });

  it("maps 4100 to a top-up hint without the orphan warning", async () => {
    const { client: c } = client({
      "POST /v1/video_avatar/task/submit": [envelopeError("4100", "credit not enough")],
    });
    const error = await caught(
      c.submit("video-avatar", { avatarSourceFrom: "1", audioSourceFrom: "1" }),
    );
    expect(error).toBeInstanceOf(TopviewApiError);
    expect(error.message).toContain("credit not enough");
    expect(error.message).toContain("Top up credits");
    expect(error.message).not.toContain(ORPHAN_HINT);
  });

  it("warns that a submit may have been created on a server-side envelope code", async () => {
    const { client: c } = client({
      "POST /v1/video_avatar/task/submit": [envelopeError("5000", "internal")],
    });
    const error = await caught(
      c.submit("video-avatar", { avatarSourceFrom: "1", audioSourceFrom: "1" }),
    );
    expect(error.message).toContain(ORPHAN_HINT);
  });

  it("never retries a submit, and warns on a 5xx", async () => {
    const { client: c, calls } = client({
      "POST /v1/m2v/task/submit": [{ status: 503, text: "busy" }],
    });
    const error = await caught(c.submitM2v({ productLink: "https://shop.example.com/p" }));
    expect(error).toBeInstanceOf(TopviewApiError);
    expect((error as TopviewApiError).status).toBe(503);
    expect(error.message).toContain(ORPHAN_HINT);
    expect(calls).toHaveLength(1);
  });

  it("warns on a submit 2xx without a task id", async () => {
    const { client: c } = client({ "POST /v1/m2v/task/submit": [ok({})] });
    const error = await caught(c.submitM2v({ productLink: "https://shop.example.com/p" }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("missing task id");
    expect(error.message).toContain(ORPHAN_HINT);
  });

  it("fails a submit that comes back failed", async () => {
    const { client: c } = client({
      "POST /v1/m2v/task/submit": [ok({ taskId: TASK_ID, status: "fail", errorMsg: "bad link" })],
    });
    const error = await caught(c.submitM2v({ productLink: "https://shop.example.com/p" }));
    expect(error).toBeInstanceOf(TopviewTaskError);
    expect(error.message).toContain("bad link");
  });

  it("maps 401 to a credentials hint naming both env vars", async () => {
    const { client: c } = client({
      "GET /v1/m2v/task/query": [{ status: 401, json: { message: "Unauthorized." } }],
    });
    const error = await caught(c.getTask("m2v", TASK_ID));
    expect(error).toBeInstanceOf(TopviewApiError);
    expect((error as TopviewApiError).status).toBe(401);
    expect(error.message).toContain("Unauthorized.");
    expect(error.message).toContain("TOPVIEW_API_KEY and TOPVIEW_UID");
  });

  it("scrubs the key from an error body that echoes it", async () => {
    const { client: c } = client({
      "GET /v1/m2v/task/query": [{ status: 400, text: `bad header Authorization: Bearer ${KEY}` }],
    });
    const error = await caught(c.getTask("m2v", TASK_ID));
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
    const cause = error.cause as HttpError;
    expect(cause).toBeInstanceOf(HttpError);
    expect(cause.snippet).not.toContain(KEY);
  });
});

describe("upload", () => {
  const credential = ok({ fileId: "file_1", uploadUrl: UPLOAD_URL });

  it("gets a credential, PUTs the bytes without the key, then checks the upload", async () => {
    const { client: c, calls } = client({
      "GET /v1/upload/credential": [credential],
      [routeKey("PUT", UPLOAD_URL)]: [{ text: "" }],
      "GET /v1/upload/check": [ok(true)],
    });
    const fileId = await c.uploadFile({
      data: new Blob([new Uint8Array([1, 2, 3])]),
      format: "png",
      name: "a.png",
    });
    expect(fileId).toBe("file_1");
    expect(calls.map((x) => x.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls[0]?.query).toEqual({ format: "png" });
    expect(calls[1]?.url).toBe(UPLOAD_URL);
    expect(calls[1]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.headers["topview-uid"]).toBeUndefined();
    expect(calls[1]?.redirect).toBe("manual");
    expect(calls[2]?.query).toEqual({ fileId: "file_1" });
  });

  it("refuses a private upload URL before sending the file", async () => {
    const { client: c, calls } = client({
      "GET /v1/upload/credential": [ok({ fileId: "file_1", uploadUrl: "https://10.0.0.5/put" })],
    });
    await expect(
      c.uploadFile({ data: new Blob(["x"]), format: "png", name: "a.png" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("fails when TopView does not confirm the upload", async () => {
    const { client: c } = client({
      "GET /v1/upload/credential": [credential],
      [routeKey("PUT", UPLOAD_URL)]: [{ text: "" }],
      "GET /v1/upload/check": [ok(false)],
    });
    await expect(
      c.uploadFile({ data: new Blob(["x"]), format: "png", name: "a.png" }),
    ).rejects.toThrow(/did not confirm the upload of a.png/);
  });

  it("maps a failed PUT", async () => {
    const { client: c, calls } = client({
      "GET /v1/upload/credential": [credential],
      [routeKey("PUT", UPLOAD_URL)]: [{ status: 403, text: "expired" }],
    });
    const error = await caught(
      c.uploadFile({ data: new Blob(["x"]), format: "png", name: "a.png" }),
    );
    expect((error as TopviewApiError).status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  it("rejects a malformed credential", async () => {
    const { client: c } = client({ "GET /v1/upload/credential": [ok({ fileId: "file_1" })] });
    await expect(
      c.uploadFile({ data: new Blob(["x"]), format: "png", name: "a.png" }),
    ).rejects.toThrow(/Malformed TopView upload credential/);
  });
});

interface KindCase {
  kind: LegacyKind;
  submit: string;
  query: string;
  result: Record<string, unknown>;
  outputs: string[];
  extra?: Record<string, unknown>;
}

const KIND_CASES: KindCase[] = [
  {
    kind: "m2v",
    submit: "/v1/m2v/task/submit",
    query: "/v1/m2v/task/query",
    result: {
      status: "success",
      costCredit: "5",
      previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL, videoDuration: 30 }],
      exportVideos: [],
    },
    outputs: [VIDEO_URL],
    extra: { costCredit: 5 },
  },
  {
    kind: "video-avatar",
    submit: "/v1/video_avatar/task/submit",
    query: "/v1/video_avatar/task/query",
    result: { status: "success", outputVideoUrl: VIDEO_URL },
    outputs: [VIDEO_URL],
  },
  {
    kind: "remove-background",
    submit: "/v1/common_task/remove_background/submit",
    query: "/v1/common_task/remove_background/query",
    result: {
      status: "success",
      bgRemovedImageFileId: "cut_1",
      maskImageFileId: "mask_1",
      bgRemovedImagePath: IMAGE_URL,
    },
    outputs: [IMAGE_URL],
    extra: { bgRemovedImageFileId: "cut_1", maskImageFileId: "mask_1" },
  },
  {
    kind: "product-avatar-replace",
    submit: "/v3/product_avatar/task/image_replace/submit",
    query: "/v3/product_avatar/task/image_replace/query",
    result: {
      status: "success",
      replaceProductResult: [{ imageId: "img_1", url: IMAGE_URL, faceExistence: true }],
    },
    outputs: [IMAGE_URL],
    extra: { images: [{ imageId: "img_1", url: IMAGE_URL, faceExistence: true }] },
  },
  {
    kind: "product-avatar-video",
    submit: "/v3/product_avatar/task/image2Video/submit",
    query: "/v3/product_avatar/task/image2Video/query",
    // The reference spells this key with a trailing space.
    result: { status: "success", "finishedVideoUrl ": VIDEO_URL },
    outputs: [VIDEO_URL],
  },
  {
    kind: "product-anyshoot",
    submit: "/v1/product_anyShoot/task/submit",
    query: "/v1/product_anyShoot/task/result",
    result: { status: "success", anyfitImages: [{ url: IMAGE_URL }, { url: "not-a-url" }] },
    outputs: [IMAGE_URL],
  },
];

describe("task kinds: documented submit and query endpoints", () => {
  it.each(KIND_CASES)("$kind submits to $submit and polls $query", async (c) => {
    const { client: tv, calls } = client({
      [`POST ${c.submit}`]: [ok({ taskId: TASK_ID, status: "init" })],
      [`GET ${c.query}`]: [ok({ taskId: TASK_ID, ...c.result })],
    });
    const body = { marker: c.kind } as never;
    const submitted = await tv.submit(c.kind, body);
    expect(submitted).toEqual({ taskId: TASK_ID, status: "init" });
    expect(calls[0]?.body).toEqual({ marker: c.kind });

    const task = await tv.getTask(c.kind, TASK_ID);
    expect(calls[1]?.query).toEqual({ taskId: TASK_ID });
    expect(task).toMatchObject({ kind: c.kind, taskId: TASK_ID, status: "success", ...c.extra });
    expect(task.outputs).toEqual(c.outputs);
  });

  it("never uses the undocumented marketing-page paths", () => {
    const paths = KIND_CASES.flatMap((c) => [c.submit, c.query]);
    for (const banned of [
      "url2video",
      "materials2video",
      "/v1/product_avatar/",
      "product_anyshoot",
    ]) {
      expect(paths.some((p) => p.includes(banned))).toBe(false);
    }
  });
});

describe("status normalization", () => {
  it.each([
    ["init", "init"],
    ["PENDING", "init"],
    ["queued", "init"],
    ["running", "running"],
    ["processing", "running"],
    ["success", "success"],
    ["succeeded", "success"],
    ["Completed", "success"],
    ["fail", "fail"],
    ["failed", "fail"],
    ["error", "fail"],
    ["cancelled", "fail"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeLegacyStatus(raw)).toBe(expected);
  });

  it("keeps unknown values non-terminal and reports a missing status as unknown", () => {
    expect(normalizeLegacyStatus("rendering-v2")).toBe("rendering-v2");
    expect(isLegacyTerminal("rendering-v2")).toBe(false);
    expect(normalizeLegacyStatus(undefined)).toBe("unknown");
    expect(normalizeLegacyStatus("  ")).toBe("unknown");
    expect(isLegacyTerminal("unknown")).toBe(false);
  });

  it("keeps an m2v task running while a preview or export still renders", () => {
    const task = normalizeTask("m2v", TASK_ID, {
      status: "success",
      previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL }],
      exportVideos: [{ scriptId: 1, status: "running" }],
    });
    expect(task.status).toBe("running");
  });

  it("prefers exported videos over previews as outputs", () => {
    const exported = "https://cdn.topview-cdn.test/out/final.mp4";
    const task = normalizeTask("m2v", TASK_ID, {
      status: "success",
      previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL }],
      exportVideos: [{ scriptId: 1, status: "success", videoUrl: exported }],
    });
    expect(task.outputs).toEqual([exported]);
  });

  it("rejects a missing result", () => {
    expect(() => normalizeTask("m2v", TASK_ID, null)).toThrow(/missing result/);
  });

  it("maps status kinds, sharing m2v for the two marketing commands", () => {
    expect(parseStatusKind("url-to-video")).toBe("m2v");
    expect(parseStatusKind("materials-to-video")).toBe("m2v");
    expect(parseStatusKind("Product-Anyshoot")).toBe("product-anyshoot");
    expect(parseStatusKind("platform")).toBe("platform");
    expect(() => parseStatusKind("cancel")).toThrow(/Unknown task kind/);
  });

  it("assertTaskSucceeded fails a failed or unfinished task", () => {
    const base = { kind: "m2v" as const, taskId: TASK_ID, outputs: [] };
    expect(() => assertTaskSucceeded({ ...base, status: "fail", errorMsg: "nope" })).toThrow(
      TopviewTaskError,
    );
    expect(() => assertTaskSucceeded({ ...base, status: "running" })).toThrow(/not finished/);
  });
});

describe("m2v export", () => {
  it("posts the task and script id, and filters exports by script", async () => {
    const { client: c, calls } = client({ "POST /v1/m2v/export": [ok({ status: "running" })] });
    const submitted = await c.exportM2v(TASK_ID, "2");
    expect(submitted).toEqual({ taskId: TASK_ID, status: "running" });
    expect(calls[0]?.body).toEqual({ taskId: TASK_ID, scriptId: "2" });

    const task = normalizeTask("m2v", TASK_ID, {
      status: "success",
      exportVideos: [
        { scriptId: 1, status: "success", videoUrl: VIDEO_URL },
        { scriptId: 2, status: "fail" },
      ],
    });
    expect(exportsOf(task, "2").map((v) => v.status)).toEqual(["fail"]);
    expect(exportsOf(task)).toHaveLength(2);
  });

  it("omits scriptId when none is given", async () => {
    const { client: c, calls } = client({
      "POST /v1/m2v/export": [ok({ taskId: TASK_ID, status: "init" })],
    });
    await c.exportM2v(TASK_ID);
    expect(calls[0]?.body).toEqual({ taskId: TASK_ID });
  });
});

describe("waitForTask", () => {
  it("polls through server-side codes and 5xx to the terminal status", async () => {
    const { client: c, calls } = client({
      "GET /v1/video_avatar/task/query": [
        envelopeError("5003", "busy"),
        { status: 503, text: "unavailable" },
        ok({ taskId: TASK_ID, status: "running" }),
        ok({ taskId: TASK_ID, status: "success", outputVideoUrl: VIDEO_URL }),
      ],
    });
    const task = await c.waitForTask("video-avatar", TASK_ID, { timeoutMs: 60_000 });
    expect(task.status).toBe("success");
    expect(calls).toHaveLength(4);
  });

  it("stops at once on a client-side error code", async () => {
    const { client: c, calls } = client({
      "GET /v1/video_avatar/task/query": [envelopeError("4004", "no such task")],
    });
    const error = await caught(c.waitForTask("video-avatar", TASK_ID, { timeoutMs: 60_000 }));
    expect((error as TopviewApiError).apiCode).toBe("4004");
    expect(calls).toHaveLength(1);
  });

  it("returns a failed task for the caller to judge", async () => {
    const { client: c } = client({
      "GET /v1/video_avatar/task/query": [ok({ taskId: TASK_ID, status: "fail", errorMsg: "x" })],
    });
    const task = await c.waitForTask("video-avatar", TASK_ID, { timeoutMs: 60_000 });
    expect(task.status).toBe("fail");
  });

  it("times out with the resume hint", async () => {
    const now = steppingClock(100);
    const { client: c } = client({
      "GET /v1/video_avatar/task/query": [ok({ taskId: TASK_ID, status: "running" })],
    });
    const error = await caught(
      c.waitForTask("video-avatar", TASK_ID, {
        timeoutMs: 10,
        resumeHint: "Resume with: multix topview status video-avatar x --wait",
        now,
      }),
    );
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toContain("Resume with: multix topview status video-avatar x --wait");
  });
});

describe("credits", () => {
  it("returns the balance only and drops the account's API keys", async () => {
    const { client: c, calls } = client({
      "GET /user/credit/detail": [
        ok({
          remainCredit: "12.5",
          expiredTime: "2027-01-01 00:00:00",
          apiKeyMap: [{ apiKey: KEY, costCredit: 3 }],
        }),
      ],
    });
    const detail = await c.getCredits();
    expect(detail).toEqual({ remainCredit: 12.5, expiredTime: "2027-01-01 00:00:00" });
    expect(JSON.stringify(detail)).not.toContain(KEY);
    expect(calls[0]?.headers["topview-uid"]).toBe(UID);
  });
});

/** A clock that advances `step` ms on every read, so a deadline passes without sleeping. */
function steppingClock(step: number): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}
