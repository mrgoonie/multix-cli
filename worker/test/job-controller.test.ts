import { describe, expect, it } from "vitest";
import {
  ContainerCapacityError,
  type JobContainerPort,
  JobController,
  POLL_SECONDS,
  SLOT_RELEASE_ATTEMPTS,
  SLOT_RELEASE_RETRY_SECONDS,
} from "../src/jobs/job-controller.js";
import {
  type JobResult,
  type JobSpec,
  type JobView,
  SERVER_AT_CAPACITY_ERROR,
} from "../src/jobs/job-protocol.js";

const SPEC: JobSpec = {
  jobId: "00000000-0000-4000-8000-000000000000",
  argv: ["media", "optimize"],
  env: { GEMINI_API_KEY: "secret-value-123456" },
  inputs: [],
  timeoutMs: 60_000,
};

const RESULT: JobResult = {
  status: "succeeded",
  exitCode: 0,
  stdout: "ok",
  stderrTail: "",
  outputs: [],
};

function fakePort(respond: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const state = {
    stored: undefined as JobView | undefined,
    saved: [] as JobView[],
    finals: [] as JobView[],
    requests: [] as { path: string; body?: string }[],
    polls: [] as number[],
    destroyed: 0,
    started: 0,
    released: 0,
    releaseFailures: 0,
    releaseRetries: [] as { attempt: number; seconds: number }[],
    running: false,
    t: 1_000,
  };
  const port: JobContainerPort = {
    load: async () => state.stored,
    save: async (view) => {
      state.stored = view;
      state.saved.push(view);
    },
    saveFinal: async (view) => {
      state.stored = view;
      state.saved.push(view);
      state.finals.push(view);
    },
    startContainer: async () => {
      state.started++;
      state.running = true;
    },
    isContainerRunning: () => state.running,
    fetchContainer: async (path, init) => {
      // Like the Durable Object: requests never boot a container.
      if (!state.running) throw new Error("not running");
      state.requests.push({ path, body: typeof init?.body === "string" ? init.body : undefined });
      return respond(path, init);
    },
    destroyContainer: async () => {
      state.destroyed++;
      state.running = false;
    },
    releaseSlot: async () => {
      if (state.releaseFailures > 0) {
        state.releaseFailures--;
        throw new Error("quota object unavailable");
      }
      state.released++;
    },
    scheduleSlotRelease: async (attempt, seconds) => {
      state.releaseRetries.push({ attempt, seconds });
    },
    schedulePoll: async (seconds) => {
      state.polls.push(seconds);
    },
    now: () => state.t,
  };
  return { port, state };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("JobController", () => {
  it("starts the job, polls until done, stores the result without the spec, then destroys", async () => {
    let done = false;
    const { port, state } = fakePort((path) => {
      if (path === "/jobs") return new Response(null, { status: 202 });
      return json(done ? { state: "done", result: RESULT } : { state: "running" });
    });
    const controller = new JobController(port);
    state.t = 5_000;
    expect(await controller.start(SPEC)).toMatchObject({ status: "running", runningAt: 5_000 });
    expect(state.requests[0]?.body).toBe(JSON.stringify(SPEC));
    expect(state.polls).toEqual([POLL_SECONDS]);

    await controller.poll();
    expect(state.polls).toHaveLength(2);
    expect(state.destroyed).toBe(0);

    done = true;
    await controller.poll();
    expect(state.polls).toHaveLength(2);
    expect(state.stored).toMatchObject({ status: "succeeded", result: RESULT, runningAt: 5_000 });
    expect(state.destroyed).toBe(1);
    expect(state.released).toBe(1);
    expect(JSON.stringify(state.saved)).not.toContain("secret-value-123456");
    // Starting again returns the stored job instead of running it twice.
    expect((await controller.start(SPEC)).status).toBe("succeeded");
    expect(state.started).toBe(1);
  });

  it("fails the job when the job server refuses it or the container cannot start", async () => {
    const refused = fakePort(() => new Response(null, { status: 409 }));
    const view = await new JobController(refused.port).start(SPEC);
    expect(view).toMatchObject({ status: "failed" });
    expect(view.error).toContain("HTTP 409");
    expect(refused.state.destroyed).toBe(1);

    const broken = fakePort(() => json({}));
    broken.port.startContainer = async () => {
      throw new Error("no capacity");
    };
    expect(await new JobController(broken.port).start(SPEC)).toMatchObject({
      status: "failed",
      error: "The job container could not be started",
    });
    expect(broken.state.released).toBe(1);

    const full = fakePort(() => json({}));
    full.port.startContainer = async () => {
      throw new ContainerCapacityError();
    };
    expect(await new JobController(full.port).start(SPEC)).toMatchObject({
      status: "failed",
      error: SERVER_AT_CAPACITY_ERROR,
    });
    expect(full.state.released).toBe(1);
  });

  it("never boots a container to read or cancel a job whose container is gone", async () => {
    const { port, state } = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "running" }),
    );
    let starts = 0;
    port.startContainer = async () => {
      starts++;
      state.running = true;
    };
    const controller = new JobController(port);
    await controller.start(SPEC);
    state.running = false; // crashed or evicted; onStop has not run yet
    const requestsBefore = state.requests.length;
    expect(await controller.status()).toMatchObject({
      status: "failed",
      error: "The job container stopped before the job finished",
    });
    expect(starts).toBe(1);
    expect(state.requests).toHaveLength(requestsBefore);
    expect(state.released).toBe(1);

    const other = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "running" }),
    );
    const second = new JobController(other.port);
    await second.start(SPEC);
    other.state.running = false;
    expect(await second.cancel()).toMatchObject({ status: "canceled" });
    expect(other.state.requests.map((r) => r.path)).toEqual(["/jobs"]);
    expect(other.state.started).toBe(1);
  });

  it("keeps a final state recorded while the job was being handed to the container", async () => {
    const { port, state } = fakePort((path) => {
      if (path === "/jobs") {
        // onStop runs while the POST is in flight and records the failure.
        state.stored = { status: "failed", createdAt: 1, finishedAt: 2, error: "stopped" };
        return new Response(null, { status: 202 });
      }
      return json({ state: "running" });
    });
    const view = await new JobController(port).start(SPEC);
    expect(view).toMatchObject({ status: "failed", error: "stopped" });
    expect(state.stored?.status).toBe("failed");
    expect(state.polls).toEqual([]);
  });

  it("fails a job left in starting after its start call was lost", async () => {
    const { port, state } = fakePort(() => json({}));
    state.stored = { status: "starting", createdAt: state.t };
    const controller = new JobController(port);
    expect((await controller.status())?.status).toBe("starting");
    state.t += 10 * 60_000;
    expect(await controller.status()).toMatchObject({ status: "failed" });
    expect(state.released).toBe(1);
  });

  it("cancels a running job and ignores a later stop", async () => {
    const { port, state } = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "running" }),
    );
    const controller = new JobController(port);
    await controller.start(SPEC);
    const canceled = await controller.cancel();
    expect(canceled).toMatchObject({ status: "canceled" });
    expect(state.requests.map((r) => r.path)).toContain("/jobs/current/cancel");
    await controller.stopped();
    expect(state.stored?.status).toBe("canceled");
  });

  it("retries a failed slot release with a growing delay, then leaves it to the lease", async () => {
    const { port, state } = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "running" }),
    );
    const controller = new JobController(port);
    await controller.start(SPEC);
    state.releaseFailures = 1;
    await controller.cancel();
    expect(state.released).toBe(0);
    expect(state.releaseRetries).toEqual([{ attempt: 2, seconds: SLOT_RELEASE_RETRY_SECONDS }]);
    await controller.releaseSlot(2);
    expect(state.released).toBe(1);

    state.releaseFailures = 99;
    state.releaseRetries = [];
    for (let attempt = 1; attempt <= SLOT_RELEASE_ATTEMPTS; attempt++) {
      await controller.releaseSlot(attempt);
    }
    expect(state.releaseRetries.map((r) => r.attempt)).toEqual([2, 3, 4, 5]);
    expect(state.releaseRetries.map((r) => r.seconds)).toEqual([30, 60, 90, 120]);
  });

  it("fails a job whose container stopped or lost it, and times out a silent one", async () => {
    const stopped = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "running" }),
    );
    const a = new JobController(stopped.port);
    await a.start(SPEC);
    await a.stopped();
    expect(stopped.state.stored).toMatchObject({ status: "failed" });

    const lost = fakePort((path) =>
      path === "/jobs" ? new Response(null, { status: 202 }) : json({ state: "idle" }),
    );
    const b = new JobController(lost.port);
    await b.start(SPEC);
    expect(await b.status()).toMatchObject({ status: "failed" });

    const silent = fakePort((path) => {
      if (path === "/jobs") return new Response(null, { status: 202 });
      throw new Error("unreachable");
    });
    const c = new JobController(silent.port);
    await c.start(SPEC);
    expect((await c.status())?.status).toBe("running");
    silent.state.t += 2 * 60 * 60_000;
    expect((await c.status())?.status).toBe("timed_out");
  });

  it("records one final state when a status read, the poll and the stop race to finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port, state } = fakePort(async (path) => {
      if (path === "/jobs") return new Response(null, { status: 202 });
      await gate;
      return json({ state: "done", result: RESULT });
    });
    const controller = new JobController(port);
    await controller.start(SPEC);
    // Both reads wait on the container; the container stops meanwhile.
    const read = controller.status();
    const poll = controller.poll();
    await controller.stopped();
    release();
    const [view] = await Promise.all([read, poll]);
    expect(state.finals).toHaveLength(1);
    expect(state.finals[0]).toMatchObject({ status: "failed" });
    expect(view).toEqual(state.finals[0]);
    expect(state.released).toBe(1);
    expect(state.destroyed).toBe(1);
  });

  it("reports an unknown job as undefined", async () => {
    const { port } = fakePort(() => json({}));
    expect(await new JobController(port).status()).toBeUndefined();
  });
});
