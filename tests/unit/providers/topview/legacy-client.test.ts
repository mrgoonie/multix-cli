/**
 * TopView Legacy API client against the in-memory fake: auth headers,
 * envelope and error mapping, submit retry policy (429 only, orphan hint on
 * ambiguous failures), task parsing quirks, polling, the upload flow with its
 * SSRF guard, and the credit detail. No network.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { TopviewApiError } from "../../../../src/providers/topview/errors.js";
import {
  TopviewLegacyClient,
  isLegacyTaskDone,
  parseLegacyTask,
} from "../../../../src/providers/topview/legacy-client.js";
import {
  LEGACY_BASE,
  LEGACY_KEY,
  TASK_ID,
  UID,
  UPLOAD_URL,
  VIDEO_URL,
  createFakeTopview,
  legacyError,
  noSleep,
  ok,
  uploadRoutes,
} from "./fake-topview.js";

const SUBMIT = "POST /v1/video_avatar/task/submit";
const QUERY = `GET /v1/video_avatar/task/query?taskId=${TASK_ID}`;

function client(routes: Parameters<typeof createFakeTopview>[0], sleeps: number[] = []) {
  const fake = createFakeTopview(routes);
  const c = new TopviewLegacyClient({
    apiKey: LEGACY_KEY,
    uid: UID,
    baseUrl: LEGACY_BASE,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fake, c, sleeps };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("auth and envelope", () => {
  it("sends Bearer key and Topview-Uid, unwraps the result", async () => {
    const { fake, c } = client({ [SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })] });
    await expect(c.submitVideoAvatar({ avatarSourceFrom: "1" })).resolves.toEqual({
      taskId: TASK_ID,
      status: "init",
    });
    const [call] = fake.calls;
    expect(call?.headers.authorization).toBe(`Bearer ${LEGACY_KEY}`);
    expect(call?.headers["topview-uid"]).toBe(UID);
    expect(call?.body).toEqual({ avatarSourceFrom: "1" });
  });

  it("maps a gateway 401 {error} to both credentials, without the key", async () => {
    const { c } = client({
      [QUERY]: [{ status: 401, json: { error: `invalid token Bearer ${LEGACY_KEY}` } }],
    });
    const e = await errorOf(c.getTask("video-avatar", TASK_ID));
    expect(e.message).toMatch(/TOPVIEW_API_KEY and TOPVIEW_UID/);
    expect(e.message).toMatch(/api-settings/);
    expect(e.message).not.toContain(LEGACY_KEY);
  });

  it.each([
    ["4100", /credits are not enough.*multix topview credit/],
    ["4007", /still running an earlier task.*4007/],
    ["4001", /rejected the request.*4001/],
    ["6001", /security problem detected \(6001\)/],
  ])("maps business code %s and does not retry it", async (code, re) => {
    const { fake, c } = client({ [SUBMIT]: [legacyError(code, "nope")] });
    const e = await errorOf(c.submitVideoAvatar({}));
    expect(e).toBeInstanceOf(TopviewApiError);
    expect(e.message).toMatch(re);
    expect(e.message).not.toMatch(/may have been created/);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects a body without the envelope", async () => {
    const { c } = client({ [QUERY]: [{ json: { taskId: TASK_ID } }] });
    await expect(c.getTask("video-avatar", TASK_ID)).rejects.toThrow(/Malformed TopView response/);
  });

  it("validates task ids before building a URL", async () => {
    const { fake, c } = client({});
    await expect(c.getTask("video-avatar", "../user/credit")).rejects.toThrow(/task id/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("submit retry policy (no idempotency key)", () => {
  it("retries a 429 with Retry-After, the same body, then succeeds", async () => {
    const { fake, c, sleeps } = client({
      [SUBMIT]: [
        { status: 429, json: { message: "slow down" }, headers: { "retry-after": "3" } },
        ok({ taskId: TASK_ID }),
      ],
    });
    await expect(c.submitVideoAvatar({ a: 1 })).resolves.toMatchObject({ taskId: TASK_ID });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.body).toEqual({ a: 1 });
    expect(sleeps).toEqual([3000]);
  });

  it.each([
    ["a 5xx", { status: 502, text: "bad gateway" }],
    ["a network error", { throws: new TypeError("fetch failed") }],
    ["a 5xxx business code", legacyError("5001", "internal")],
    ["a 2xx without taskId", ok({})],
  ])("never resubmits after %s and points at the credit log", async (_, response) => {
    const { fake, c } = client({ [SUBMIT]: [response] });
    const e = await errorOf(c.submitVideoAvatar({}));
    expect(e.message).toMatch(/may have been created \(and billed\) anyway/);
    expect(e.message).toMatch(/multix topview credit/);
    expect(fake.calls).toHaveLength(1);
  });

  it("appends the chain resume hint to the orphan hint", async () => {
    const { c } = client({
      "POST /v3/product_avatar/task/image_replace/submit": [{ status: 500, text: "boom" }],
    });
    const e = await errorOf(c.submitImageReplace({}, "Resume with --bg-removed-file-id f1"));
    expect(e.message).toMatch(/may have been created.*Resume with --bg-removed-file-id f1/);
  });
});

describe("task parsing", () => {
  it("accepts costCredit as a numeric string and the 'finishedVideoUrl ' key", () => {
    const task = parseLegacyTask(
      "product-avatar-video",
      { taskId: TASK_ID, status: "success", costCredit: "12.5", "finishedVideoUrl ": VIDEO_URL },
      TASK_ID,
    );
    expect(task.costCredit).toBe(12.5);
    expect(task.outputs).toEqual([{ url: VIDEO_URL, label: "video" }]);
  });

  it("keeps the remove-bg file ids and the replace results", () => {
    const bg = parseLegacyTask(
      "remove-bg",
      { status: "success", bgRemovedImageFileId: "f_nobg", maskImageFileId: "f_mask" },
      TASK_ID,
    );
    expect(bg).toMatchObject({ bgRemovedImageFileId: "f_nobg", maskImageFileId: "f_mask" });
    const rep = parseLegacyTask(
      "product-avatar-replace",
      {
        status: "success",
        replaceProductResult: [
          { imageId: "img1", url: "https://cdn.topview.test/1.png", faceExistence: false },
          { imageId: "../bad" },
        ],
      },
      TASK_ID,
    );
    expect(rep.replaceResults).toEqual([
      { imageId: "img1", url: "https://cdn.topview.test/1.png", faceExistence: false },
    ]);
  });

  it("treats unknown statuses as not finished, and an m2v export in progress as not done", () => {
    expect(isLegacyTaskDone({ kind: "m2v", taskId: TASK_ID, status: "queued", outputs: [] })).toBe(
      false,
    );
    const exporting = parseLegacyTask(
      "m2v",
      {
        status: "success",
        previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL }],
        exportVideos: [{ scriptId: 1, status: "running" }],
      },
      TASK_ID,
    );
    expect(isLegacyTaskDone(exporting)).toBe(false);
    expect(exporting.outputs.map((o) => o.label)).toEqual(["preview-1"]);
  });

  it("rejects a task without a status", () => {
    expect(() => parseLegacyTask("m2v", { taskId: TASK_ID }, TASK_ID)).toThrow(/without a status/);
  });
});

describe("polling", () => {
  it("polls until finished, retrying transient errors, at least every 3s", async () => {
    const { c, sleeps } = client({
      [QUERY]: [
        ok({ status: "init" }),
        { status: 503, text: "busy" },
        legacyError("5000", "temporary"),
        ok({ status: "running" }),
        ok({ status: "success", outputVideoUrl: VIDEO_URL, costCredit: 4 }),
      ],
    });
    const task = await c.waitForTask("video-avatar", TASK_ID, { timeoutMs: 600_000 });
    expect(task).toMatchObject({ status: "success", costCredit: 4 });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(3000);
  });

  it("times out with the resume hint", async () => {
    let t = 0;
    const { c } = client({ [QUERY]: [ok({ status: "running" })] });
    const e = await errorOf(
      c.waitForTask("video-avatar", TASK_ID, {
        timeoutMs: 10_000,
        resumeHint: "Resume with: multix topview status video-avatar x --wait",
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
    );
    expect(e).toBeInstanceOf(PollTimeoutError);
    expect(e.message).toMatch(/Resume with: multix topview status video-avatar/);
  });
});

describe("upload", () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])]);

  it("credential → PUT without TopView headers → check", async () => {
    const { fake, c } = client(uploadRoutes("png", "file123"));
    await expect(c.uploadFile({ data: blob, format: ".PNG", filename: "a.png" })).resolves.toBe(
      "file123",
    );
    expect(fake.calls.map((x) => x.key)).toEqual([
      "GET /v1/upload/credential?format=png",
      `PUT ${UPLOAD_URL}`,
      "GET /v1/upload/check?fileId=file123",
    ]);
    const put = fake.calls[1];
    expect(put?.headers.authorization).toBeUndefined();
    expect(put?.headers["topview-uid"]).toBeUndefined();
    expect(put?.rawBody).toBe(blob);
  });

  it.each([
    "http://s3.topview.test/u",
    "https://127.0.0.1/u",
    "https://169.254.169.254/latest",
    "https://localhost/u",
  ])("refuses the upload URL %s before sending any bytes", async (uploadUrl) => {
    const { fake, c } = client({
      "GET /v1/upload/credential?format=png": [ok({ fileId: "file123", uploadUrl })],
    });
    await expect(c.uploadFile({ data: blob, format: "png", filename: "a.png" })).rejects.toThrow(
      /Refusing to upload to/,
    );
    expect(fake.calls.filter((x) => x.method === "PUT")).toHaveLength(0);
  });

  it("fails when the upload check is not confirmed", async () => {
    const routes = uploadRoutes("png", "file123");
    routes["GET /v1/upload/check?fileId=file123"] = [ok(false)];
    const { c } = client(routes);
    await expect(c.uploadFile({ data: blob, format: "png", filename: "a.png" })).rejects.toThrow(
      /did not confirm the upload of a\.png/,
    );
  });

  it("maps a failed PUT without leaking the signed URL", async () => {
    const routes = uploadRoutes("png", "file123");
    routes[`PUT ${UPLOAD_URL}`] = [{ status: 403, text: "AccessDenied" }];
    const { c } = client(routes);
    const e = await errorOf(c.uploadFile({ data: blob, format: "png", filename: "a.png" }));
    expect(e.message).toMatch(/403/);
    expect(e.message).not.toContain("SIGNED_UPLOAD_SIG");
  });
});

describe("credit detail", () => {
  it("returns the balance and recent tasks, never the API keys", async () => {
    const { c } = client({
      "GET /user/credit/detail": [
        ok({
          remainCredit: "120.5",
          expiredTime: "2026-12-31",
          apiKeyMap: {
            [LEGACY_KEY]: [
              { taskId: TASK_ID, taskType: "video_avatar", costCredit: 4, date: "2026-10-28" },
            ],
          },
        }),
      ],
    });
    const detail = await c.creditDetail();
    expect(detail).toEqual({
      remainCredit: 120.5,
      expiredTime: "2026-12-31",
      recentTasks: [
        { taskId: TASK_ID, taskType: "video_avatar", costCredit: 4, date: "2026-10-28" },
      ],
    });
    expect(JSON.stringify(detail)).not.toContain(LEGACY_KEY);
  });
});
