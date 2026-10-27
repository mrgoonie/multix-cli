/**
 * A run that exits with 128 + a signal number gets the CANCELLED envelope with
 * its real exit code, and a hint that matches what the run had already done.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeRun } from "../../../src/agent/agent-runtime.js";
import { run } from "../../../src/agent/run-state.js";

function finalizeWith(exitCode: number, state: { calls?: number; cleanupSkipped?: boolean } = {}) {
  const writes: string[] = [];
  // The envelope goes to fd 1 with fs.writeSync.
  vi.spyOn(fs, "writeSync").mockImplementation((_fd, data) => {
    writes.push(String(data));
    return Buffer.byteLength(String(data));
  });
  run.finalized = false;
  run.json = true;
  run.command = ""; // keeps the run out of the history ledger
  run.calls = Array.from({ length: state.calls ?? 0 }, () => ({
    method: "POST",
    host: "api.example.com",
    path: "/v1/predictions",
    status: 200,
    ms: 5,
  }));
  run.cleanupSkipped = state.cleanupSkipped ?? false;
  const returned = finalizeRun({ exitCode });
  vi.restoreAllMocks();
  const envelope = JSON.parse(writes.join("").trim().split("\n").pop() ?? "{}");
  return { returned, envelope };
}

afterEach(() => vi.restoreAllMocks());

describe("finalizeRun for a signal exit", () => {
  it("reports CANCELLED with the real exit code and the plain rerun hint", () => {
    const { returned, envelope } = finalizeWith(143);
    expect(returned).toBe(143);
    expect(envelope).toMatchObject({ ok: false, exit_code: 143 });
    expect(envelope.error).toMatchObject({
      code: "CANCELLED",
      hint: "The run was cancelled; nothing was left behind. Rerun the command.",
    });
  });

  it("warns against a blind rerun once a provider request was sent", () => {
    const { returned, envelope } = finalizeWith(130, { calls: 1 });
    expect(returned).toBe(130);
    expect(envelope.error.code).toBe("CANCELLED");
    expect(envelope.error.hint).toMatch(/may have run and been billed/);
  });

  it("does not claim a clean exit when the cleanup was cut short", () => {
    const { envelope } = finalizeWith(130, { cleanupSkipped: true });
    expect(envelope.error.hint).toMatch(/remove leftover temporary files/);
  });

  it("leaves other exit codes to the message classifier", () => {
    const { returned, envelope } = finalizeWith(1);
    expect(returned).toBe(1);
    expect(envelope.error.code).toBe("UNKNOWN");
  });
});
