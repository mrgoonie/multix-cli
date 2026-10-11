/**
 * completeJobs must hand each parallel job its own first-poll offset, so the
 * first status reads of a multi-language batch are spread out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeygenClient } from "../../../../src/providers/heygen/client.js";
import type { HeygenJobState, WaitOptions } from "../../../../src/providers/heygen/jobs.js";

const { waitForJob } = vi.hoisted(() => ({
  waitForJob: vi.fn(
    async (_c: unknown, kind: string, id: string, _o: WaitOptions): Promise<HeygenJobState> =>
      ({
        kind,
        id,
        status: "completed",
        done: true,
        succeeded: true,
        outputUrl: `https://files.heygen.test/${id}.mp4`,
        raw: {},
      }) as HeygenJobState,
  ),
}));

vi.mock("../../../../src/providers/heygen/jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/providers/heygen/jobs.js")>()),
  waitForJob,
}));

const { completeJobs } = await import("../../../../src/providers/heygen/node-helpers.js");
const { staggerOffsetMs } = await import("../../../../src/providers/heygen/jobs.js");

const logger = { info() {}, debug() {}, warn() {}, success() {}, error() {} };

afterEach(() => {
  vi.restoreAllMocks();
  waitForJob.mockClear();
});

describe("completeJobs stagger", () => {
  it("passes staggerOffsetMs(index) to each job's wait", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const finished = await completeJobs(
      {} as HeygenClient,
      "translation",
      ["t1", "t2", "t3"],
      { pollInterval: "10000", waitTimeout: "60000", download: false, json: true },
      logger as never,
    );
    expect(finished).toHaveLength(3);
    const delays = waitForJob.mock.calls.map((c) => c[3].startDelayMs);
    expect(delays).toEqual([0, 1, 2].map((i) => staggerOffsetMs(i, 10_000)));
    expect(delays).toEqual([0, 500, 1000]);
    expect(waitForJob.mock.calls.every((c) => c[3].timeoutMs === 60_000)).toBe(true);
  });
});
