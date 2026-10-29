import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../src/core/errors.js";

/** Loads a fresh run state, finalizes a failed `gemini generate`, returns its envelope. */
async function finalizeFailed(partial?: { hint: string; rerunArgs: string[] }) {
  vi.resetModules();
  const written: string[] = [];
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Buffer) => {
    if (fd !== 1) throw new Error(`unexpected write to fd ${fd}`);
    written.push(buf.toString());
    return buf.length;
  }) as typeof fs.writeSync);
  try {
    const { run, recordPartialRun } = await import("../../../src/agent/run-state.js");
    const { finalizeRun } = await import("../../../src/agent/agent-runtime.js");
    run.json = true;
    run.command = "gemini generate";
    run.group = "gemini";
    run.argv = ["gemini", "generate", "--prompt", "a cat", "--num-images", "3"];
    run.actionStarted = true;
    run.requestsStarted = 2;
    if (partial) recordPartialRun(partial.hint, partial.rerunArgs);
    finalizeRun({
      exitCode: 1,
      error: new HttpError(503, "overloaded", "https://example.test/v1"),
    });
    return JSON.parse(written.join(""));
  } finally {
    spy.mockRestore();
  }
}

describe("finalizeRun after a partly saved run", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the error code, adds the hint and narrows the rerun to the rest", async () => {
    const envelope = await finalizeFailed({
      hint: "1 image(s) were already saved.",
      rerunArgs: ["--num-images", "2"],
    });
    expect(envelope.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(envelope.error.hint).toMatch(/1 image\(s\) were already saved\.$/);
    expect(envelope.next).toContain(`multix rerun ${envelope.history_id} --num-images 2`);
    expect(envelope.next).not.toContain(`multix rerun ${envelope.history_id}`);
  });

  it("suggests a plain rerun when nothing was saved", async () => {
    const envelope = await finalizeFailed();
    expect(envelope.error.hint).not.toMatch(/already saved/);
    expect(envelope.next).toContain(`multix rerun ${envelope.history_id}`);
  });
});
