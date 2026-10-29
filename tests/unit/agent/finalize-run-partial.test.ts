import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RunState = typeof import("../../../src/agent/run-state.js").run;

let dir: string;

/** Fresh run state per case; the saved file is passed as --output so it counts as an output. */
async function finalizeFailed(setup: (run: RunState) => void) {
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
    run.command = "gemini generate";
    run.group = "gemini";
    run.argv = ["gemini", "generate", "--prompt", "a cat", "--num-images=3", "--json"];
    run.requestsStarted = 2;
    setup(run);
    const { HttpError } = await import("../../../src/core/errors.js");
    const error = new HttpError(503, "overloaded", "https://example.test/v1/generate");
    finalizeRun({ exitCode: 1, error });
    return JSON.parse(written.join(""));
  } finally {
    spy.mockRestore();
  }
}

describe("finalizeRun after a partial success", () => {
  beforeEach(() => {
    vi.stubEnv("MULTIX_HISTORY", "0");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-partial-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the saved files and suggests only the remainder, never a full rerun", async () => {
    const saved = path.join(dir, "first.png");
    fs.writeFileSync(saved, "png");
    const envelope = await finalizeFailed((run) => {
      run.options.output = saved;
      run.partial = { options: { "--num-images": "2", "--output": null } };
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.outputs).toHaveLength(1);
    expect(envelope.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(envelope.error.hint).toMatch(/^1 file\(s\) were saved before the failure; keep them/);
    expect(envelope.next[0]).toBe("multix gemini generate --prompt 'a cat' --json --num-images 2");
    expect(envelope.next.some((c: string) => c.startsWith("multix rerun"))).toBe(false);
  });

  it("leaves the failure as is when nothing was saved", async () => {
    const envelope = await finalizeFailed((run) => {
      run.partial = { options: { "--num-images": "2" } };
    });
    expect(envelope.outputs).toEqual([]);
    expect(envelope.error.hint).not.toMatch(/were saved/);
    expect(envelope.next.some((c: string) => c.includes("--num-images 2"))).toBe(false);
  });
});

describe("withOptions", () => {
  it("replaces spaced and = forms and drops options set to null", async () => {
    const { withOptions } = await import("../../../src/agent/agent-runtime.js");
    expect(
      withOptions(["gen", "--num-images", "4", "--output=a.png", "--prompt", "x"], {
        "--num-images": "1",
        "--output": null,
      }),
    ).toEqual(["gen", "--prompt", "x", "--num-images", "1"]);
  });
});
