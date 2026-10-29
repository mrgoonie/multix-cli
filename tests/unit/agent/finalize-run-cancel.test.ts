import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FinalizeArgs = { exitCode: number; error?: unknown };

/**
 * finalizeRun keeps the module-level run state, so each case loads a fresh copy
 * and captures the envelope it writes to fd 1. An `input` function builds the
 * error after that load, so its class is the one finalizeRun checks against.
 */
async function finalizeCancelled(
  requestsStarted: number,
  setup: (run: typeof import("../../../src/agent/run-state.js").run) => void = () => {},
  input: FinalizeArgs | ((errors: typeof import("../../../src/core/errors.js")) => FinalizeArgs) = {
    exitCode: 143,
  },
) {
  vi.resetModules();
  const written: string[] = [];
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Buffer) => {
    if (fd !== 1) throw new Error(`unexpected write to fd ${fd}`);
    written.push(buf.toString());
    return buf.length;
  }) as typeof fs.writeSync);
  try {
    const { run } = await import("../../../src/agent/run-state.js");
    const { finalizeRun } = await import("../../../src/agent/agent-runtime.js");
    run.json = true;
    run.requestsStarted = requestsStarted;
    const errors = await import("../../../src/core/errors.js");
    setup(run);
    const exitCode = finalizeRun(typeof input === "function" ? input(errors) : input);
    return { exitCode, envelope: JSON.parse(written.join("")) };
  } finally {
    spy.mockRestore();
  }
}

describe("finalizeRun on a signal exit", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("reports CANCELLED with the signal's exit code when nothing reached a provider", async () => {
    const { exitCode, envelope } = await finalizeCancelled(0);
    expect(exitCode).toBe(143);
    expect(envelope.exit_code).toBe(143);
    expect(envelope.error).toMatchObject({
      code: "CANCELLED",
      hint: "The run was cancelled; nothing was left behind. Rerun the command.",
    });
  });

  it("warns against a blind rerun once a provider request was sent", async () => {
    const { exitCode, envelope } = await finalizeCancelled(1);
    expect(exitCode).toBe(143);
    expect(envelope.error.code).toBe("CANCELLED");
    expect(envelope.error.hint).toMatch(/pay twice/);
  });

  it("uses the outcome a phase recorded on its signal over the request count", async () => {
    const interrupted = { hint: "Maybe accepted; check the console.", retryable: false };
    const { envelope } = await finalizeCancelled(2, (run) => {
      run.interrupted = interrupted;
    });
    expect(envelope.error).toMatchObject({ code: "CANCELLED", ...interrupted });
  });

  it("prefers a tracked in-flight job's resume over a recorded outcome", async () => {
    const { envelope } = await finalizeCancelled(2, (run) => {
      run.interrupted = { hint: "Maybe accepted.", retryable: false };
      run.inFlight = { id: "p1", resume: "multix atlas status p1 --wait --download" };
    });
    expect(envelope.error.hint).toContain("Job p1 was submitted");
    expect(envelope.next[0]).toBe("multix atlas status p1 --wait --download");
  });

  it("ignores a recorded outcome when the run threw or did not exit by a signal", async () => {
    const setup = (run: { interrupted?: { hint: string; retryable: boolean } }) => {
      run.interrupted = { hint: "Maybe accepted.", retryable: false };
    };
    const thrown = await finalizeCancelled(1, setup, { exitCode: 130, error: new Error("boom") });
    expect(thrown.envelope.error.hint).not.toBe("Maybe accepted.");
    const plain = await finalizeCancelled(1, setup, { exitCode: 1 });
    expect(plain.envelope.error.hint).not.toBe("Maybe accepted.");
  });
});

describe("finalizeRun after a failure with a job in flight", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => vi.unstubAllEnvs());

  const resume = "multix fal result fal-ai/flux/schnell req-1 --download";
  /** A fal run whose result fetch got a 429 after fal accepted the job. */
  const rateLimited = ({ HttpError }: typeof import("../../../src/core/errors.js")) => ({
    exitCode: 1,
    error: new Error("Failed to fetch result for fal request req-1: HTTP 429", {
      cause: new HttpError(429, "slow down", "https://queue.fal.run/x", 30_000),
    }),
  });
  const falRun =
    (inFlight?: { id: string; resume: string }) =>
    (run: typeof import("../../../src/agent/run-state.js").run) => {
      run.command = "fal run";
      run.group = "fal";
      run.argv = ["fal", "run", "fal-ai/flux/schnell"];
      run.actionStarted = true;
      if (inFlight) run.inFlight = inFlight;
    };

  it("offers a rerun when nothing was accepted (baseline)", async () => {
    const { envelope } = await finalizeCancelled(1, falRun(), rateLimited);
    expect(envelope.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(envelope.next[0]).toMatch(/^multix rerun h_/);
  });

  it("resumes an accepted job instead of rerunning it, keeping the classification", async () => {
    const { exitCode, envelope } = await finalizeCancelled(
      2,
      falRun({ id: "req-1", resume }),
      rateLimited,
    );
    expect(envelope.error).toMatchObject({
      code: "RATE_LIMITED",
      http_status: 429,
      retry_after_s: 30,
      retryable: false,
      message: "Failed to fetch result for fal request req-1: HTTP 429",
    });
    expect(envelope.error.hint).toContain("Job req-1 was accepted");
    expect(envelope.error.hint).toContain("Do not rerun; wait 30s, then resume");
    expect(envelope.next[0]).toBe(resume);
    expect(envelope.next.some((c: string) => c.startsWith("multix rerun"))).toBe(false);
    expect(exitCode).toBe(envelope.exit_code);
  });

  it("resumes after a non-zero exit with no thrown error", async () => {
    const { envelope } = await finalizeCancelled(2, falRun({ id: "req-1", resume }), {
      exitCode: 1,
    });
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.hint).toContain("Do not rerun; resume it with the next command.");
    expect(envelope.next[0]).toBe(resume);
  });

  it("leaves a job the provider failed or canceled to the usual advice", async () => {
    for (const terminal of [true, false]) {
      const { envelope } = await finalizeCancelled(
        2,
        falRun({ id: "req-1", resume }),
        ({ ProviderJobFailedError }) => ({
          exitCode: 1,
          error: new ProviderJobFailedError("job req-1 ended", "fal", { terminal }),
        }),
      );
      if (terminal) expect(envelope.error.code).toBe("JOB_FAILED");
      expect(envelope.error.hint).not.toContain("Do not rerun");
      expect(envelope.next).not.toContain(resume);
    }
  });

  it("leaves a rejection of the accepted job (a 422 result fetch) to its own advice", async () => {
    const { envelope } = await finalizeCancelled(
      2,
      falRun({ id: "req-1", resume }),
      ({ HttpError }) => ({
        exitCode: 1,
        error: new Error("Failed to fetch result for fal request req-1: HTTP 422", {
          cause: new HttpError(422, "prompt is required", "https://queue.fal.run/x"),
        }),
      }),
    );
    expect(envelope.error.code).not.toBe("RATE_LIMITED");
    expect(envelope.error.hint).not.toContain("Do not rerun");
    expect(envelope.next).not.toContain(resume);
  });

  it("keeps the key advice when a poll fails on the key", async () => {
    const { envelope } = await finalizeCancelled(
      2,
      falRun({ id: "req-1", resume }),
      ({ HttpError }) => ({
        exitCode: 1,
        error: new Error("Failed to poll status for fal request req-1: HTTP 401", {
          cause: new HttpError(401, "unauthorized", "https://queue.fal.run/x"),
        }),
      }),
    );
    expect(envelope.error).toMatchObject({ code: "INVALID_KEY", retryable: false });
    expect(envelope.error.hint).toContain("Do not rerun; fix the key, then resume");
    expect(envelope.error.hint).toContain("The provider rejected the key");
    expect(envelope.next[0]).toBe(resume);
  });

  it("keeps the signal-exit wording", async () => {
    const { envelope } = await finalizeCancelled(2, falRun({ id: "req-1", resume }));
    expect(envelope.error).toMatchObject({ code: "CANCELLED", retryable: false });
    expect(envelope.error.hint).toBe(
      "Job req-1 was submitted before the run stopped; it runs on (or has finished) and is billed. Do not rerun; resume it with the next command.",
    );
    expect(envelope.next[0]).toBe(resume);
  });
});
