import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { ConfigError } from "../../../../src/core/errors.js";
import {
  TopviewLegacyClient,
  TopviewTaskFailedError,
  isLegacyTaskDone,
} from "../../../../src/providers/topview/legacy-client.js";
import {
  LEGACY_BASE,
  LEGACY_KEY,
  UID,
  createFakeTopview,
  legacyError,
  noSleep,
  ok,
} from "./fake-topview.js";

const SUBMIT = "POST /v1/m2v/task/submit";
const QUERY = "GET /v1/m2v/task/query";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return classifyError(e).code;
  }
  throw new Error("expected a rejection");
}

describe("TopviewLegacyClient submit", () => {
  it("sends the key and UID headers and returns the task id", async () => {
    const { legacy, calls } = createFakeTopview({
      [SUBMIT]: { body: ok({ taskId: "task_1", status: "init" }) },
    });
    const id = await legacy.submit("m2v", { productLink: "https://shop.test/p/1" });
    expect(id).toBe("task_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${LEGACY_BASE}/v1/m2v/task/submit`);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${LEGACY_KEY}`);
    expect(calls[0]?.headers["topview-uid"]).toBe(UID);
    expect(calls[0]?.body).toEqual({ productLink: "https://shop.test/p/1" });
  });

  it("4100 is a quota refusal and is sent once", async () => {
    const { legacy, calls } = createFakeTopview({
      [SUBMIT]: { body: legacyError("4100", "Credit not enough") },
    });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("QUOTA_EXCEEDED");
    expect(calls).toHaveLength(1);
  });

  it("4002 is a wrong key", async () => {
    const { legacy } = createFakeTopview({
      [SUBMIT]: { body: legacyError("4002", "Sign error") },
    });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("INVALID_KEY");
  });

  it("HTTP 401 is a wrong key", async () => {
    const { legacy } = createFakeTopview({
      [SUBMIT]: { status: 401, body: legacyError("401", "Unauthorized") },
    });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("INVALID_KEY");
  });

  it("HTTP 429 on submit is a rate limit and is not retried", async () => {
    const { legacy, calls } = createFakeTopview({
      [SUBMIT]: { status: 429, body: legacyError("429", "Too many requests") },
    });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(1);
  });

  it("a success envelope without a taskId is an unknown outcome", async () => {
    const { legacy } = createFakeTopview({ [SUBMIT]: { body: ok({}) } });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("a body that is not the envelope is an unknown outcome", async () => {
    const { legacy } = createFakeTopview({ [SUBMIT]: { text: "<html>ok</html>" } });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("a reset connection is an unknown outcome; a refused one is a network error", async () => {
    const reset = createFakeTopview({ [SUBMIT]: { fail: "ECONNRESET" } });
    expect(await codeOf(reset.legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
    expect(reset.calls).toHaveLength(1);
    const refused = createFakeTopview({ [SUBMIT]: { fail: "ECONNREFUSED" } });
    expect(await codeOf(refused.legacy.submit("m2v", {}))).toBe("NETWORK_ERROR");
  });

  it("a timeout is an unknown outcome", async () => {
    const { legacy } = createFakeTopview({ [SUBMIT]: { fail: "timeout" } });
    expect(await codeOf(legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
  });

  it("a gateway 502 is unknown; a 503 with TopView's busy body is definite", async () => {
    const gateway = createFakeTopview({
      [SUBMIT]: { status: 502, text: "<html>Bad Gateway</html>" },
    });
    expect(await codeOf(gateway.legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
    const busy = createFakeTopview({
      [SUBMIT]: { status: 503, body: legacyError("5003", "Server is busy") },
    });
    expect(await codeOf(busy.legacy.submit("m2v", {}))).toBe("PROVIDER_UNAVAILABLE");
  });

  it("envelope 5000 is unknown; 5003 is a definite refusal", async () => {
    const internal = createFakeTopview({ [SUBMIT]: { body: legacyError("5000", "Internal") } });
    expect(await codeOf(internal.legacy.submit("m2v", {}))).toBe("UNKNOWN_REMOTE_STATE");
    const busy = createFakeTopview({ [SUBMIT]: { body: legacyError("5003", "Server is busy") } });
    const err = await busy.legacy.submit("m2v", {}).catch((e: unknown) => e);
    expect((err as Error).message).toContain("5003");
    expect(classifyError(err).code).not.toBe("UNKNOWN_REMOTE_STATE");
  });

  it("the error never carries the key", async () => {
    const { legacy } = createFakeTopview({ [SUBMIT]: { fail: "ECONNRESET" } });
    const err = await legacy.submit("m2v", {}).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(LEGACY_KEY);
  });
});

describe("TopviewLegacyClient polling", () => {
  it("retries 429 (Retry-After) and busy codes, then returns the finished task", async () => {
    const { legacy, calls } = createFakeTopview({
      [QUERY]: [
        { status: 429, body: legacyError("429", "slow down"), headers: { "retry-after": "1" } },
        { body: legacyError("5003", "Server is busy") },
        { body: ok({ taskId: "t1", status: "running" }) },
        { body: ok({ taskId: "t1", status: "success", costCredit: 3 }) },
      ],
    });
    const slept: number[] = [];
    const task = await legacy.waitForTask("m2v", "t1", {
      timeoutMs: 600_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(task.status).toBe("success");
    expect(task.costCredit).toBe(3);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe(`${LEGACY_BASE}/v1/m2v/task/query?taskId=t1`);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  it("returns a failed task for the caller to report", async () => {
    const { legacy } = createFakeTopview({
      [QUERY]: { body: ok({ taskId: "t1", status: "fail", errorMsg: "bad image" }) },
    });
    const task = await legacy.waitForTask("m2v", "t1", { timeoutMs: 60_000, sleep: noSleep });
    expect(task.status).toBe("fail");
    const err = new TopviewTaskFailedError(task);
    expect(err.message).toContain("bad image");
    expect(classifyError(err).code).toBe("JOB_FAILED");
  });

  it("an interrupted wait times out with the resume hint", async () => {
    let now = 0;
    const { legacy } = createFakeTopview({
      [QUERY]: { body: ok({ taskId: "t1", status: "running" }) },
    });
    const err = await legacy
      .waitForTask("m2v", "t1", {
        timeoutMs: 10_000,
        resumeHint: "Resume with: multix topview status t1 --task m2v --download",
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as Error).message).toContain("multix topview status t1 --task m2v");
  });

  it("a query without a status is a schema mismatch, not retried", async () => {
    const { legacy, calls } = createFakeTopview({ [QUERY]: { body: ok({ taskId: "t1" }) } });
    await expect(
      legacy.waitForTask("m2v", "t1", { timeoutMs: 60_000, sleep: noSleep }),
    ).rejects.toThrow(/schema mismatch/);
    expect(calls).toHaveLength(1);
  });

  it("an export is done only once an exported video is final", () => {
    const previewOnly = { taskId: "t1", status: "success", previewVideos: [{ videoUrl: "x" }] };
    expect(isLegacyTaskDone("m2v-export", previewOnly)).toBe(false);
    expect(isLegacyTaskDone("m2v", previewOnly)).toBe(true);
    const exported = { ...previewOnly, exportVideos: [{ status: "success", videoUrl: "y" }] };
    expect(isLegacyTaskDone("m2v-export", exported)).toBe(true);
    expect(isLegacyTaskDone("m2v-export", { taskId: "t1", status: "fail" })).toBe(true);
  });

  it("rejects an invalid task id before any request", async () => {
    const { legacy, calls } = createFakeTopview({});
    await expect(legacy.getTask("m2v", "../x")).rejects.toThrow(/Invalid TopView task id/);
    expect(calls).toHaveLength(0);
  });
});

describe("TopviewLegacyClient upload", () => {
  it("runs credential -> signed PUT (no TopView headers) -> check", async () => {
    const signed = "https://bucket.s3.test/upload/abc?X-Amz-Signature=secret";
    const { legacy, calls } = createFakeTopview({
      "GET /v1/upload/credential": { body: ok({ fileId: "file_1", uploadUrl: signed }) },
      "PUT bucket.s3.test": { status: 200, text: "" },
      "GET /v1/upload/check": { body: ok(true) },
    });
    const id = await legacy.uploadFile(new Blob(["png"]), "png");
    expect(id).toBe("file_1");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls[0]?.url).toBe(`${LEGACY_BASE}/v1/upload/credential?format=png`);
    expect(calls[1]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.headers["topview-uid"]).toBeUndefined();
    expect(calls[2]?.url).toBe(`${LEGACY_BASE}/v1/upload/check?fileId=file_1`);
  });

  it("refuses a format TopView does not accept", async () => {
    const { legacy, calls } = createFakeTopview({});
    await expect(legacy.uploadCredential("exe")).rejects.toThrow(/does not accept \.exe/);
    expect(calls).toHaveLength(0);
  });

  it("an unconfirmed upload fails", async () => {
    const { legacy } = createFakeTopview({
      "GET /v1/upload/credential": {
        body: ok({ fileId: "file_1", uploadUrl: "https://bucket.s3.test/u" }),
      },
      "PUT bucket.s3.test": { status: 200, text: "" },
      "GET /v1/upload/check": { body: ok(false) },
    });
    await expect(legacy.uploadFile(new Blob(["x"]), "png")).rejects.toThrow(/did not confirm/);
  });
});

describe("TopviewLegacyClient config", () => {
  it("needs both the key and the UID", () => {
    expect(() => new TopviewLegacyClient({ apiKey: LEGACY_KEY, uid: "" })).toThrow(ConfigError);
    expect(() => new TopviewLegacyClient({ apiKey: "", uid: UID })).toThrow(/TOPVIEW_API_KEY/);
    expect(classifyError(new ConfigError("TOPVIEW_UID is not set")).code).toBe("MISSING_KEY");
  });
});
