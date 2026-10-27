import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * finalizeRun keeps the module-level run state, so each case loads a fresh copy
 * and captures the envelope it writes to fd 1.
 */
async function finalizeCancelled(requestsStarted: number) {
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
    const exitCode = finalizeRun({ exitCode: 143 });
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
});
