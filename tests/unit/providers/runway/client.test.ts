/**
 * RunwayClient against the in-memory fake API: headers, create/poll/cancel,
 * error mapping, the 429-only create retry, orphan hints, uploads and
 * response validation. No network or paid calls.
 */

import { describe, expect, it } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import {
  ORPHAN_HINT,
  RunwayApiError,
  RunwayClient,
  RunwayTaskError,
  assertSucceeded,
} from "../../../../src/providers/runway/client.js";
import { RUNWAY_API_VERSION } from "../../../../src/providers/runway/models.js";
import {
  BASE,
  OUTPUT_URL,
  SECRET,
  TASK_ID,
  createFakeRunway,
  noSleep,
  task,
} from "./fake-runway.js";

function client(routes: Parameters<typeof createFakeRunway>[0]) {
  const fake = createFakeRunway(routes);
  const sleeps: number[] = [];
  const c = new RunwayClient({
    apiKey: SECRET,
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client: c, calls: fake.calls, sleeps };
}

const created = { id: TASK_ID, estimatedCost: { credits: 60 } };
const t2v = { model: "gen4.5", promptText: "a city", ratio: "1280:720", duration: 5 };

describe("RunwayClient create", () => {
  it("sends the versioned headers and the request body", async () => {
    const { client: c, calls } = client({ "POST /v1/text_to_video": [{ json: created }] });
    await expect(c.textToVideo(t2v)).resolves.toEqual(created);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls[0]?.headers["x-runway-version"]).toBe(RUNWAY_API_VERSION);
    expect(calls[0]?.body).toEqual(t2v);
  });

  it("uses the image_to_video and text_to_image endpoints", async () => {
    const { client: c, calls } = client({
      "POST /v1/image_to_video": [{ json: created }],
      "POST /v1/text_to_image": [{ json: created }],
    });
    await c.imageToVideo({
      model: "gen4_turbo",
      promptImage: "https://a.example/x.png",
      ratio: "960:960",
    });
    await c.textToImage({ model: "gen4_image", promptText: "p", ratio: "1024:1024" });
    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/v1/image_to_video`,
      `${BASE}/v1/text_to_image`,
    ]);
  });

  it("retries a 429 (nothing was created) honouring Retry-After, capped", async () => {
    const {
      client: c,
      calls,
      sleeps,
    } = client({
      "POST /v1/text_to_video": [
        { status: 429, json: { error: "slow down" }, headers: { "retry-after": "3" } },
        { status: 429, json: { error: "slow down" }, headers: { "retry-after": "999" } },
        { json: created },
      ],
    });
    await expect(c.textToVideo(t2v)).resolves.toEqual(created);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 30_000]);
  });

  it("gives up on 429 after the retry budget", async () => {
    const { client: c, calls } = client({
      "POST /v1/text_to_video": [{ status: 429, json: { error: "slow down" } }],
    });
    await expect(c.textToVideo(t2v)).rejects.toThrow(/rate limit reached \(429\)/);
    expect(calls).toHaveLength(3);
  });

  it.each([
    [500, /server error \(500\)/],
    [502, /server error \(502\)/],
  ])("never retries a %i create and adds the orphan hint", async (status, re) => {
    const { client: c, calls } = client({
      "POST /v1/text_to_video": [{ status, json: { error: "boom" } }],
    });
    const err = await c.textToVideo(t2v).catch((e) => e);
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.message).toMatch(re);
    expect(err.message).toContain(ORPHAN_HINT);
    expect(calls).toHaveLength(1);
  });

  it("adds the orphan hint on a network error or timeout", async () => {
    const { client: c, calls } = client({
      "POST /v1/text_to_video": [{ throws: new TypeError("fetch failed") }],
    });
    const err = await c.textToVideo(t2v).catch((e) => e);
    expect(err.message).toMatch(/Network error contacting Runway/);
    expect(err.message).toContain(ORPHAN_HINT);
    expect(calls).toHaveLength(1);

    const timeout = client({
      "POST /v1/text_to_video": [
        { throws: Object.assign(new Error("timed out"), { name: "TimeoutError" }) },
      ],
    });
    const err2 = await timeout.client.textToVideo(t2v).catch((e) => e);
    expect(err2.message).toContain(ORPHAN_HINT);
  });

  it("adds the orphan hint to a malformed 2xx create response", async () => {
    const bad = client({ "POST /v1/text_to_video": [{ json: { id: "../../etc" } }] });
    const err = await bad.client.textToVideo(t2v).catch((e) => e);
    expect(err.message).toMatch(/invalid task id/);
    expect(err.message).toContain(ORPHAN_HINT);

    const notJson = client({ "POST /v1/text_to_video": [{ text: "<html>" }] });
    const err2 = await notJson.client.textToVideo(t2v).catch((e) => e);
    expect(err2.message).toContain(ORPHAN_HINT);
  });

  it.each([
    [401, /rejected the API secret \(401\).*RUNWAYML_API_SECRET/],
    [402, /needs more credits for model gen4\.5 \(402\)/],
    [403, /denied access to model gen4\.5 \(403\)/],
    [400, /rejected the request for model gen4\.5 \(400\): Invalid input — ratio: bad ratio/],
  ])("maps %i to an actionable error without an orphan hint", async (status, re) => {
    const { client: c } = client({
      "POST /v1/text_to_video": [
        {
          status,
          json: { error: "Invalid input", issues: [{ path: ["ratio"], message: "bad ratio" }] },
        },
      ],
    });
    const err = await c.textToVideo(t2v).catch((e) => e);
    expect(err).toBeInstanceOf(RunwayApiError);
    expect(err.status).toBe(status);
    expect(err.message).toMatch(re);
    expect(err.message).not.toContain(ORPHAN_HINT);
    expect(err.message).not.toContain(SECRET);
  });

  it("refuses a cross-origin redirect instead of sending the secret along", async () => {
    const { client: c, calls } = client({
      "POST /v1/text_to_video": [
        { status: 307, text: "", headers: { location: "https://evil.example/steal" } },
      ],
    });
    await expect(c.textToVideo(t2v)).rejects.toThrow();
    expect(calls.every((x) => x.url.startsWith(BASE))).toBe(true);
  });
});

describe("RunwayClient tasks", () => {
  it("rejects a task id that is not a UUID before any request", async () => {
    const { client: c, calls } = client({});
    await expect(c.getTask("../v1/uploads")).rejects.toThrow(/Invalid Runway task id/);
    await expect(c.deleteTask("abc")).rejects.toThrow(/Invalid Runway task id/);
    expect(calls).toHaveLength(0);
  });

  it("polls no faster than every five seconds until SUCCEEDED", async () => {
    const {
      client: c,
      calls,
      sleeps,
    } = client({
      [`GET /v1/tasks/${TASK_ID}`]: [
        { json: task("PENDING") },
        { json: task("THROTTLED") },
        { json: task("RUNNING", { progress: 0.5 }) },
        { json: task("SUCCEEDED", { output: [OUTPUT_URL], cost: { credits: 60 } }) },
      ],
    });
    const final = await c.waitForTask(TASK_ID, { timeoutMs: 600_000, intervalMs: 1000 });
    expect(final.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(4);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(5000);
  });

  it("retries transient poll failures (5xx, 429) instead of failing the wait", async () => {
    const { client: c } = client({
      [`GET /v1/tasks/${TASK_ID}`]: [
        { status: 503, json: { error: "busy" } },
        { status: 429, json: {}, headers: { "retry-after": "7" } },
        { json: task("SUCCEEDED", { output: [OUTPUT_URL] }) },
      ],
    });
    await expect(c.waitForTask(TASK_ID, { timeoutMs: 600_000 })).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("returns FAILED/CANCELLED tasks, which assertSucceeded turns into errors", async () => {
    const { client: c } = client({
      [`GET /v1/tasks/${TASK_ID}`]: [
        {
          json: task("FAILED", { failure: "Content moderation", failureCode: "SAFETY.INPUT.TEXT" }),
        },
      ],
    });
    const failed = await c.waitForTask(TASK_ID, { timeoutMs: 60_000 });
    expect(() => assertSucceeded(failed)).toThrow(RunwayTaskError);
    expect(() => assertSucceeded(failed)).toThrow(
      /failed \[SAFETY\.INPUT\.TEXT\]: Content moderation/,
    );
    expect(() => assertSucceeded({ id: TASK_ID, status: "CANCELLED" })).toThrow(/cancelled/);
  });

  it("times out with a resume hint", async () => {
    let clock = 0;
    const { client: c } = client({ [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("RUNNING") }] });
    const err = await c
      .waitForTask(TASK_ID, {
        timeoutMs: 12_000,
        resumeHint: "Resume with: x",
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("Resume with: x");
  });

  it("rejects malformed task payloads", async () => {
    const cases = [
      { id: TASK_ID, status: "DONE" },
      { id: "nope", status: "RUNNING" },
      { id: TASK_ID, status: "SUCCEEDED" },
      { id: TASK_ID, status: "SUCCEEDED", output: [1] },
      { id: TASK_ID, status: "RUNNING", cost: "free" },
    ];
    for (const body of cases) {
      const { client: c } = client({ [`GET /v1/tasks/${TASK_ID}`]: [{ json: body }] });
      await expect(c.getTask(TASK_ID)).rejects.toThrow(/Malformed Runway response/);
    }
  });

  it("maps a 404 on a task to a clear message", async () => {
    const { client: c } = client({ [`GET /v1/tasks/${TASK_ID}`]: [{ status: 404, json: {} }] });
    await expect(c.getTask(TASK_ID)).rejects.toThrow(/could not find task .* \(404\)/);
  });

  it("deletes with DELETE /v1/tasks/{id} (204)", async () => {
    const { client: c, calls } = client({
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    });
    await c.deleteTask(TASK_ID.toUpperCase());
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/v1/tasks/${TASK_ID}`);
  });
});

describe("RunwayClient uploads", () => {
  const ticket = {
    uploadUrl: "https://uploads.runway.test/bucket",
    fields: { key: "k", policy: "p" },
    runwayUri: "runway://uploads/abc",
  };

  it("requests an ephemeral upload and posts the form without the secret", async () => {
    const { client: c, calls } = client({
      "POST /v1/uploads": [{ json: ticket }],
      "POST https://uploads.runway.test/bucket": [{ status: 204, text: "" }],
    });
    const uri = await c.uploadEphemeral({
      data: new Blob([new Uint8Array(10)]),
      filename: "a.png",
    });
    expect(uri).toBe("runway://uploads/abc");
    expect(calls[0]?.body).toEqual({ filename: "a.png", type: "ephemeral" });
    const form = calls[1]?.rawBody as FormData;
    expect(form.get("key")).toBe("k");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  it("refuses to post files to a private or non-https upload URL", async () => {
    for (const uploadUrl of [
      "http://uploads.runway.test/b",
      "https://169.254.169.254/x",
      "https://localhost/x",
    ]) {
      const { client: c, calls } = client({
        "POST /v1/uploads": [{ json: { ...ticket, uploadUrl } }],
      });
      await expect(
        c.uploadEphemeral({ data: new Blob([new Uint8Array(10)]), filename: "a.png" }),
      ).rejects.toThrow(/Refusing to upload to/);
      expect(calls).toHaveLength(1);
    }
  });

  it("rejects a malformed ticket and a failed storage upload", async () => {
    const bad = client({ "POST /v1/uploads": [{ json: { ...ticket, runwayUri: "https://x" } }] });
    await expect(
      bad.client.uploadEphemeral({ data: new Blob(["x"]), filename: "a.png" }),
    ).rejects.toThrow(/Malformed Runway upload response/);

    const failing = client({
      "POST /v1/uploads": [{ json: ticket }],
      "POST https://uploads.runway.test/bucket": [{ status: 403, text: "denied" }],
    });
    await expect(
      failing.client.uploadEphemeral({ data: new Blob(["x"]), filename: "a.png" }),
    ).rejects.toThrow(/403/);
  });
});

it("requires an API secret", () => {
  expect(() => new RunwayClient({ apiKey: "" })).toThrow(/secret is required/);
  expect(noSleep).toBeTypeOf("function");
});
