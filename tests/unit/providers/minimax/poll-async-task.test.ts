/**
 * MiniMax async task polling: a failed task ends the poll as the provider's
 * job failure instead of waiting for the timeout.
 */

import { afterEach, describe, expect, it } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { pollAsyncTask } from "../../../../src/providers/minimax/client.js";
import { mockFetch } from "../../../helpers/mock-fetch.js";

let restore: () => void = () => {};
afterEach(() => restore());

describe("pollAsyncTask", () => {
  it("stops on a Fail status and reports it as a failed job", async () => {
    restore = mockFetch({
      "query/video_generation": {
        body: { task_id: "3091846", status: "Fail", base_resp: { status_code: 0 } },
      },
    });
    const err = await pollAsyncTask("3091846", "video_generation", "k", {
      intervalMs: 1,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Task 3091846 failed/);
    expect(classifyError(err).code).toBe("JOB_FAILED");
  });

  it("returns the result on Success", async () => {
    restore = mockFetch({
      "query/video_generation": {
        body: { task_id: "1", status: "Success", file_id: "f1", base_resp: { status_code: 0 } },
      },
    });
    const r = await pollAsyncTask("1", "video_generation", "k", {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(r.file_id).toBe("f1");
  });
});
