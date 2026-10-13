import { describe, expect, it } from "vitest";
import { type JobContainerPort, JobController, POLL_SECONDS } from "../src/jobs/job-controller.js";
import type { JobResult, JobSpec, JobView } from "../src/jobs/job-protocol.js";

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
    requests: [] as { path: string; body?: string }[],
    polls: [] as number[],
    destroyed: 0,
    started: 0,
    t: 1_000,
  };
  const port: JobContainerPort = {
    load: async () => state.stored,
    save: async (view) => {
      state.stored = view;
      state.saved.push(view);
    },
    startContainer: async () => {
      state.started++;
    },
    fetchContainer: async (path, init) => {
      state.requests.push({ path, body: typeof init?.body === "string" ? init.body : undefined });
      return respond(path, init);
    },
    destroyContainer: async () => {
      state.destroyed++;
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
    expect(await controller.start(SPEC)).toMatchObject({ status: "running" });
    expect(state.requests[0]?.body).toBe(JSON.stringify(SPEC));
    expect(state.polls).toEqual([POLL_SECONDS]);

    await controller.poll();
    expect(state.polls).toHaveLength(2);
    expect(state.destroyed).toBe(0);

    done = true;
    await controller.poll();
    expect(state.polls).toHaveLength(2);
    expect(state.stored).toMatchObject({ status: "succeeded", result: RESULT });
    expect(state.destroyed).toBe(1);
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

  it("reports an unknown job as undefined", async () => {
    const { port } = fakePort(() => json({}));
    expect(await new JobController(port).status()).toBeUndefined();
  });
});
