import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * finalizeRun keeps the module-level run state, so each case loads a fresh copy
 * and captures the envelope it writes to fd 1.
 */
async function finalizeCancelled(
  requestsStarted: number,
  setup: (run: typeof import("../../../src/agent/run-state.js").run) => void = () => {},
  input: { exitCode: number; error?: unknown } = { exitCode: 143 },
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
    setup(run);
    const exitCode = finalizeRun(input);
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
