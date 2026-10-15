/**
 * RunwayClient against the in-memory fake API: headers, create retries,
 * error mapping, the orphan hint, response validation, cancel/delete safety,
 * polling and the ephemeral upload. No network or paid calls.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  ORPHAN_HINT,
  RunwayApiError,
  RunwayClient,
  RunwayTaskError,
  assertSucceeded,
  validateTask,
} from "../../../../src/providers/runway/client.js";
import { BASE, SECRET, TASK_ID, createFakeRunway, noSleep, task } from "./fake-runway.js";

function client(routes: Parameters<typeof createFakeRunway>[0]) {
  const fake = createFakeRunway(routes);
  return {
    fake,
    client: new RunwayClient({ apiKey: SECRET, baseUrl: BASE, fetch: fake.fetch, sleep: noSleep }),
  };
}

const T2V = { model: "gen4.5", promptText: "a cat", ratio: "1280:720", duration: 5 };

describe("RunwayClient create", () => {
  it("sends auth and version headers and returns the id and estimate", async () => {
    const { fake, client: c } = client({
      "POST /v1/text_to_video": [{ json: { id: TASK_ID, estimatedCost: { credits: 60 } } }],
    });
    const created = await c.createTextToVideo(T2V);
    expect(created).toEqual({ id: TASK_ID, estimatedCost: { credits: 60 } });
    const call = fake.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(call?.headers["x-runway-version"]).toBe("2024-11-06");
    expect(call?.body).toEqual(T2V);
  });

  it("retries 429 up to twice, then reports the rate limit", async () => {
    const { fake, client: c } = client({
      "POST /v1/text_to_image": [
        { status: 429, json: { error: "slow down" }, headers: { "retry-after": "1" } },
        { status: 429, json: { error: "slow down" } },
        { json: { id: TASK_ID } },
      ],
    });
    await expect(
      c.createTextToImage({ model: "gen4_image", promptText: "x", ratio: "1280:720" }),
    ).resolves.toEqual({ id: TASK_ID });
    expect(fake.calls).toHaveLength(3);

    const limited = client({ "POST /v1/text_to_image": [{ status: 429, json: {} }] });
    const err = await limited.client
      .createTextToImage({ model: "gen4_image", promptText: "x", ratio: "1280:720" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.message).toMatch(/rate limit/);
    expect(err.message).not.toContain(ORPHAN_HINT);
    expect(limited.fake.calls).toHaveLength(3);
  });

  it.each([
    [401, { error: "bad key" }, /RUNWAYML_API_SECRET/],
    [402, { error: "no" }, /could not bill/],
    [
      400,
      { error: "You do not have enough credits to run this task" },
      /could not bill.*Add credits/,
    ],
    [
      400,
      { error: "Invalid ratio" },
      /rejected the request for model gen4.5 \(400\): Invalid ratio/,
    ],
  ])("maps %i to an actionable error without the orphan hint", async (status, json, re) => {
    const { client: c } = client({ "POST /v1/text_to_video": [{ status, json }] });
    const err = await c.createTextToVideo(T2V).catch((e) => e);
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.message).toMatch(re);
    expect(err.message).not.toContain("dashboard");
    expect(err.message).not.toContain(SECRET);
  });

  it("adds the orphan hint (and does not retry) on 5xx, network errors and unusable 2xx bodies", async () => {
    const server = client({ "POST /v1/text_to_video": [{ status: 503, text: "busy" }] });
    const e1 = await server.client.createTextToVideo(T2V).catch((e) => e);
    expect(e1.message).toMatch(/server error \(503\)/);
    expect(e1.message).toContain(ORPHAN_HINT);
    expect(server.fake.calls).toHaveLength(1);

    const net = client({ "POST /v1/text_to_video": [{ throws: new TypeError("fetch failed") }] });
    const e2 = await net.client.createTextToVideo(T2V).catch((e) => e);
    expect(e2.message).toContain(ORPHAN_HINT);

    const bad = client({ "POST /v1/text_to_video": [{ json: { id: "../../etc" } }] });
    const e3 = await bad.client.createTextToVideo(T2V).catch((e) => e);
    expect(e3.message).toMatch(/invalid task id/);
    expect(e3.message).toContain(ORPHAN_HINT);
  });
});

describe("task validation", () => {
  it("rejects unknown statuses and succeeded tasks without outputs", () => {
    expect(() => validateTask({ id: TASK_ID, status: "DONE" })).toThrow(/unknown task status/);
    expect(() => validateTask({ id: TASK_ID, status: "SUCCEEDED", output: [] })).toThrow(
      /without output URLs/,
    );
    expect(() => validateTask({ id: "a/b", status: "RUNNING" })).toThrow(/invalid task id/);
  });

  it("treats FAILED and CANCELLED as errors with the failure code", () => {
    const failed = validateTask(
      task("FAILED", { failure: "Prompt flagged", failureCode: "SAFETY.INPUT.TEXT" }),
    );
    expect(() => assertSucceeded(failed)).toThrow(RunwayTaskError);
    expect(() => assertSucceeded(failed)).toThrow(/failed \[SAFETY.INPUT.TEXT\]: Prompt flagged/);
    expect(() => assertSucceeded(validateTask(task("CANCELLED")))).toThrow(/cancelled/);
  });
});

describe("getTask / waitForTask", () => {
  it("maps a missing task to a clear 404 message", async () => {
    const { client: c } = client({ [`GET /v1/tasks/${TASK_ID}`]: [{ status: 404, json: {} }] });
    await expect(c.getTask(TASK_ID)).rejects.toThrow(/could not find task .* \(404\)/);
  });

  it("refuses an unsafe task id before any request", async () => {
    const { fake, client: c } = client({});
    await expect(c.getTask("../v1/organization")).rejects.toThrow(/Invalid Runway task id/);
    expect(fake.calls).toHaveLength(0);
  });

  it("polls through transient errors to a terminal status", async () => {
    const { fake, client: c } = client({
      [`GET /v1/tasks/${TASK_ID}`]: [
        { json: task("PENDING") },
        { status: 502, text: "bad gateway" },
        { json: task("RUNNING", { progress: 0.5 }) },
        { json: task("SUCCEEDED", { output: ["https://cdn.runway.test/a.mp4"] }) },
      ],
    });
    const final = await c.waitForTask(TASK_ID, { timeoutMs: 600_000 });
    expect(final.status).toBe("SUCCEEDED");
    expect(fake.calls).toHaveLength(4);
  });

  it("times out with the resume hint", async () => {
    let t = 0;
    const { client: c } = client({ [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("RUNNING") }] });
    const err = await c
      .waitForTask(TASK_ID, {
        timeoutMs: 20_000,
        resumeHint: "Resume with: multix runway status x",
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("multix runway status x");
  });
});

describe("cancelTask", () => {
  it("cancels a running task", async () => {
    const { fake, client: c } = client({
      [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("RUNNING") }],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    });
    const result = await c.cancelTask(TASK_ID);
    expect(result.action).toBe("cancelled");
    expect(fake.calls.map((x) => x.method)).toEqual(["GET", "DELETE"]);
  });

  it("refuses to delete a finished task unless allowed", async () => {
    const routes = {
      [`GET /v1/tasks/${TASK_ID}`]: [
        { json: task("SUCCEEDED", { output: ["https://cdn.runway.test/a.mp4"] }) },
      ],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    };
    const refused = client(routes);
    expect((await refused.client.cancelTask(TASK_ID)).action).toBe("refused");
    expect(refused.fake.calls.map((x) => x.method)).toEqual(["GET"]);

    const allowed = client(routes);
    expect((await allowed.client.cancelTask(TASK_ID, { allowDelete: true })).action).toBe(
      "deleted",
    );
  });
});

describe("uploadEphemeral", () => {
  const data = new Blob([new Uint8Array(600)], { type: "image/png" });

  it("posts the form to the signed URL without the API key and returns the runway:// URI", async () => {
    const { fake, client: c } = client({
      "POST /v1/uploads": [
        {
          json: {
            uploadUrl: "https://storage.runway.test/upload",
            fields: { key: "abc", policy: "p" },
            runwayUri: "runway://ephemeral/abc",
          },
        },
      ],
      "POST https://storage.runway.test/upload": [{ status: 204, text: "" }],
    });
    const uri = await c.uploadEphemeral({ data, filename: "big.png", contentType: "image/png" });
    expect(uri).toBe("runway://ephemeral/abc");
    expect(fake.calls[0]?.body).toEqual({ filename: "big.png", type: "ephemeral" });
    const upload = fake.calls[1];
    expect(upload?.headers.authorization).toBeUndefined();
    expect(upload?.redirect).toBe("manual");
    expect(upload?.rawBody).toBeInstanceOf(FormData);
  });

  it.each([
    ["http://storage.runway.test/upload", /https/i],
    ["https://127.0.0.1/upload", /local|private|refus/i],
  ])("refuses an unsafe upload URL %s", async (uploadUrl, re) => {
    const { fake, client: c } = client({
      "POST /v1/uploads": [{ json: { uploadUrl, fields: {}, runwayUri: "runway://x" } }],
    });
    await expect(
      c.uploadEphemeral({ data, filename: "big.png", contentType: "image/png" }),
    ).rejects.toThrow(re);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects a malformed upload slot", async () => {
    const { client: c } = client({
      "POST /v1/uploads": [
        { json: { uploadUrl: "https://s.runway.test", fields: {}, runwayUri: "https://x" } },
      ],
    });
    await expect(
      c.uploadEphemeral({ data, filename: "big.png", contentType: "image/png" }),
    ).rejects.toThrow(/Malformed Runway upload response/);
  });
});
