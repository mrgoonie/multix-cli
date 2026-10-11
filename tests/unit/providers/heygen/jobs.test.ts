import { describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { HeygenClient } from "../../../../src/providers/heygen/client.js";
import { HeygenJobFailedError } from "../../../../src/providers/heygen/heygen-errors.js";
import {
  agentState,
  assertJobSucceeded,
  getJobState,
  resumeCommand,
  staggerOffsetMs,
  videoState,
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
  it("follows the session to its video, re-reading the session each poll", async () => {
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
    // One session read per poll; the video is read once a video_id exists.
    expect(fake.callsTo("GET /v3/video-agents/s1")).toHaveLength(3);
    expect(fake.callsTo("GET /v3/videos/v9")).toHaveLength(2);
    expect(onPoll).toHaveBeenCalledTimes(3);
  });

  it("ends the wait when the session fails after its video was assigned", async () => {
    const { c, fake } = client({
      "GET /v3/video-agents/s2": [
        { body: { data: { session_id: "s2", status: "generating", video_id: "v2" } } },
        {
          body: {
            data: {
              session_id: "s2",
              status: "failed",
              video_id: "v2",
              error: { code: "paid_tier_quota_exceeded", message: "Quota exceeded" },
            },
          },
        },
      ],
      // The video never leaves processing; only the session reports the failure.
      "GET /v3/videos/v2": { body: { data: { id: "v2", status: "processing" } } },
    });
    const state = await waitForJob(c, "agent", "s2", fast);
    expect(state).toMatchObject({
      done: true,
      succeeded: false,
      failureCode: "paid_tier_quota_exceeded",
      failureMessage: "Quota exceeded",
    });
    expect(fake.callsTo("GET /v3/video-agents/s2")).toHaveLength(2);
  });

  it("keeps waiting when the session hit context_limit_exceeded but the video renders", async () => {
    const { c } = client({
      "GET /v3/video-agents/s3": {
        body: {
          data: {
            session_id: "s3",
            status: "failed",
            video_id: "v3",
            error: { code: "context_limit_exceeded", message: "chat full" },
          },
        },
      },
      "GET /v3/videos/v3": [
        { body: { data: { id: "v3", status: "processing" } } },
        { body: { data: { id: "v3", status: "completed", video_url: "https://f.test/v3.mp4" } } },
      ],
    });
    const state = await waitForJob(c, "agent", "s3", fast);
    expect(state.succeeded).toBe(true);
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

describe("burned-in captions", () => {
  const both = {
    id: "v1",
    status: "completed",
    video_url: "https://f.test/clean.mp4",
    captioned_video_url: "https://f.test/burned.mp4",
  };

  it("delivers captioned_video_url when burn captions were requested", () => {
    expect(videoState(both as never).outputUrl).toBe("https://f.test/clean.mp4");
    const s = videoState(both as never, "video", "v1", { burnCaptions: true });
    expect(s).toMatchObject({ succeeded: true, outputUrl: "https://f.test/burned.mp4" });
  });

  it("fails clearly when the captioned render is missing", () => {
    const s = videoState({ ...both, captioned_video_url: undefined } as never, "video", "v1", {
      burnCaptions: true,
    });
    expect(s).toMatchObject({
      done: true,
      succeeded: false,
      failureCode: "captioned_video_missing",
    });
    expect(s.outputUrl).toBeUndefined();
  });

  it("keeps polling while the video is still rendering", () => {
    const s = videoState({ id: "v1", status: "processing" } as never, "video", "v1", {
      burnCaptions: true,
    });
    expect(s.done).toBe(false);
  });
});

describe("resumeCommand", () => {
  it("quotes IDs that are not shell-safe and carries --burn-captions", () => {
    expect(resumeCommand("video", "abc_123-x")).toBe(
      "multix heygen status abc_123-x --type video --wait --download",
    );
    expect(resumeCommand("video", "a b;rm -rf'x")).toBe(
      "multix heygen status 'a b;rm -rf'\\''x' --type video --wait --download",
    );
    expect(resumeCommand("video", "v1", { burnCaptions: true })).toMatch(/--burn-captions$/);
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

  it("staggers first polls of parallel jobs: one step per job, capped", () => {
    expect(staggerOffsetMs(0, 10_000)).toBe(0);
    expect(staggerOffsetMs(1, 10_000)).toBe(500);
    expect(staggerOffsetMs(3, 10_000)).toBe(1500);
    expect(staggerOffsetMs(50, 10_000)).toBe(5000);
    // Never wait longer per step than the poll interval itself.
    expect(staggerOffsetMs(2, 1)).toBe(2);
  });

  it("waits startDelayMs before the first poll and counts it against the timeout", async () => {
    const { c, fake } = client({
      "GET /v3/videos/v1": { body: { data: { id: "v1", status: "processing" } } },
    });
    let t = 0;
    const events: string[] = [];
    const sleep = async (ms: number) => {
      events.push(`sleep ${ms}`);
      t += ms;
    };
    const err = await waitForJob(c, "video", "v1", {
      timeoutMs: 2000,
      intervalMs: 600,
      jitter: false,
      startDelayMs: 500,
      sleep,
      now: () => t,
      onPoll: () => events.push("poll"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(events[0]).toBe("sleep 500");
    expect(events[1]).toBe("poll");
    // 500 ms start delay + polling never exceeds the 2000 ms budget.
    expect(t).toBeLessThanOrEqual(2000);
    expect(fake.calls.length).toBeGreaterThan(0);
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
