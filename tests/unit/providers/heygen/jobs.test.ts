import { describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { HeygenClient } from "../../../../src/providers/heygen/client.js";
import { HeygenJobFailedError } from "../../../../src/providers/heygen/heygen-errors.js";
import {
  agentState,
  assertJobSucceeded,
  getJobState,
  resumeCommand,
  waitForJob,
} from "../../../../src/providers/heygen/jobs.js";
import { type FakeReply, fakeHeygen, noSleep } from "./fake-heygen.js";

function client(routes: Record<string, FakeReply | FakeReply[]>) {
  const fake = fakeHeygen(routes);
  const c = new HeygenClient({
    apiKey: "k",
    baseUrl: "https://api.heygen.test",
    fetch: fake.fetch,
    sleep: noSleep,
  });
  return { c, fake };
}

const fast = { timeoutMs: 60_000, intervalMs: 1, jitter: false, sleep: noSleep };

describe("status by type", () => {
  it("reads each job family from its own endpoint", async () => {
    const { c, fake } = client({
      "GET /v3/videos/v1": {
        body: { data: { id: "v1", status: "completed", video_url: "https://f.test/v1.mp4" } },
      },
      "GET /v3/video-translations/t1": {
        body: {
          data: {
            id: "t1",
            status: "running",
            output_language: "Spanish",
          },
        },
      },
      "GET /v3/lipsyncs/l1": {
        body: { data: { id: "l1", status: "failed", failure_message: "bad audio" } },
      },
      "GET /v3/models/videos/m1": { body: { data: { video_id: "m1", status: "cancelled" } } },
    });

    const video = await getJobState(c, "video", "v1");
    expect(video).toMatchObject({
      done: true,
      succeeded: true,
      outputUrl: "https://f.test/v1.mp4",
    });

    const tr = await getJobState(c, "translation", "t1");
    expect(tr).toMatchObject({ done: false, status: "running", outputLanguage: "Spanish" });

    const lip = await getJobState(c, "lipsync", "l1");
    expect(lip).toMatchObject({ done: true, succeeded: false, failureMessage: "bad audio" });

    const model = await getJobState(c, "model-video", "m1");
    expect(model).toMatchObject({ done: true, succeeded: false, status: "cancelled" });

    expect(fake.calls.map((x) => x.path)).toEqual([
      "/v3/videos/v1",
      "/v3/video-translations/t1",
      "/v3/lipsyncs/l1",
      "/v3/models/videos/m1",
    ]);
  });
});

describe("Video Agent session -> video lifecycle", () => {
  it("follows the session to its video and then polls only the video", async () => {
    const { c, fake } = client({
      "GET /v3/video-agents/s1": [
        { body: { data: { session_id: "s1", status: "thinking" } } },
        {
          body: { data: { session_id: "s1", status: "generating", video_id: "v9", progress: 40 } },
        },
      ],
      "GET /v3/videos/v9": [
        { body: { data: { id: "v9", status: "processing" } } },
        {
          body: {
            data: {
              id: "v9",
              status: "completed",
              video_url: "https://f.test/v9.mp4?sig=abc",
              thumbnail_url: "https://f.test/v9.jpg",
            },
          },
        },
      ],
    });
    const onPoll = vi.fn();
    const state = await waitForJob(c, "agent", "s1", { ...fast, onPoll });
    expect(state).toMatchObject({
      kind: "agent",
      id: "s1",
      sessionId: "s1",
      videoId: "v9",
      done: true,
      succeeded: true,
      outputUrl: "https://f.test/v9.mp4?sig=abc",
    });
    // Session read twice (until video_id appears), then cached.
    expect(fake.callsTo("GET /v3/video-agents/s1")).toHaveLength(2);
    expect(fake.callsTo("GET /v3/videos/v9")).toHaveLength(2);
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it("treats waiting_for_input before a video as a terminal failure", () => {
    const s = agentState({ session_id: "s", status: "waiting_for_input" } as never);
    expect(s).toMatchObject({ done: true, succeeded: false, failureCode: "waiting_for_input" });
  });

  it("treats a failed session as failure and keeps the error code", () => {
    const s = agentState({
      session_id: "s",
      status: "failed",
      error: { code: "generation_failed", message: "nope" },
    } as never);
    expect(s).toMatchObject({ done: true, succeeded: false, failureCode: "generation_failed" });
  });

  it("flags a completed session without a video", () => {
    const s = agentState({ session_id: "s", status: "completed" } as never);
    expect(s).toMatchObject({ done: true, succeeded: false, failureCode: "no_video" });
  });

  it("lets the video status win once assigned, but surfaces a failed session", () => {
    const ok = agentState(
      { session_id: "s", status: "failed", error: { code: "context_limit_exceeded" } } as never,
      { id: "v", status: "completed", video_url: "https://f.test/v.mp4" } as never,
    );
    expect(ok.succeeded).toBe(true);

    const bad = agentState(
      {
        session_id: "s",
        status: "failed",
        error: { code: "render_failed", message: "x" },
      } as never,
      { id: "v", status: "processing" } as never,
    );
    expect(bad).toMatchObject({ done: true, succeeded: false, failureCode: "render_failed" });
  });
});

describe("avatar video lifecycle", () => {
  it("polls pending -> processing -> completed", async () => {
    const { c, fake } = client({
      "GET /v3/videos/v1": [
        { body: { data: { id: "v1", status: "pending" } } },
        { body: { data: { id: "v1", status: "processing" } } },
        {
          body: {
            data: {
              id: "v1",
              status: "completed",
              video_url: "https://f.test/v1.mp4",
              subtitle_url: "https://f.test/v1.srt",
            },
          },
        },
      ],
    });
    const s = await waitForJob(c, "video", "v1", fast);
    expect(s).toMatchObject({ succeeded: true, captionUrl: "https://f.test/v1.srt" });
    expect(fake.calls).toHaveLength(3);
  });

  it("returns failed videos with failure_code/message and assertJobSucceeded throws", async () => {
    const { c } = client({
      "GET /v3/videos/v1": {
        body: {
          data: {
            id: "v1",
            status: "failed",
            failure_code: "avatar_not_found",
            failure_message: "Avatar look missing",
          },
        },
      },
    });
    const s = await waitForJob(c, "video", "v1", fast);
    expect(s.succeeded).toBe(false);
    let err: unknown;
    try {
      assertJobSucceeded(s);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeygenJobFailedError);
    expect((err as HeygenJobFailedError).failureCode).toBe("avatar_not_found");
    expect((err as Error).message).toMatch(/Avatar look missing/);
  });
});

describe("polling robustness", () => {
  it("retries a 429 during polling and honours Retry-After", async () => {
    const { c } = client({
      "GET /v3/videos/v1": [
        {
          status: 429,
          headers: { "Retry-After": "3" },
          body: { error: { code: "rate_limit_exceeded", message: "slow" } },
        },
        { body: { data: { id: "v1", status: "completed", video_url: "https://f.test/a.mp4" } } },
      ],
    });
    const sleep = vi.fn(noSleep);
    const s = await waitForJob(c, "video", "v1", { ...fast, sleep });
    expect(s.succeeded).toBe(true);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("times out with a resume hint", async () => {
    const { c } = client({
      "GET /v3/videos/v1": { body: { data: { id: "v1", status: "processing" } } },
    });
    let t = 0;
    const err = await waitForJob(c, "video", "v1", {
      timeoutMs: 1000,
      intervalMs: 400,
      jitter: false,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      resumeHint: `Resume with: ${resumeCommand("video", "v1")}`,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("multix heygen status v1 --type video --wait --download");
  });

  it("does not retry non-transient errors such as 404", async () => {
    const { c, fake } = client({
      "GET /v3/videos/nope": {
        status: 404,
        body: { error: { code: "not_found", message: "Video not found" } },
      },
    });
    const err = await waitForJob(c, "video", "nope", fast).catch((e) => e);
    expect(err.message).toMatch(/--type/);
    expect(fake.calls).toHaveLength(1);
  });
});
