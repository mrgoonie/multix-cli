/**
 * Replicate commands driven through commander with the real env-based client
 * (global fetch stubbed with the fake Replicate API). Covers option parsing
 * and the status/cancel actions; no network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { ReplicatePredictionError } from "../../../../src/providers/replicate/client.js";
import { registerReplicateCommands } from "../../../../src/providers/replicate/commands/index.js";
import { parsePreferWaitSeconds } from "../../../../src/providers/replicate/commands/prediction-flow.js";
import { BASE, TOKEN, createFakeReplicate, prediction } from "./fake-replicate.js";

const ID = "pred0001xyz";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let tmp: string;
let output: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-replicate-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("REPLICATE_API_TOKEN", TOKEN);
  vi.stubEnv("REPLICATE_BASE_URL", BASE);
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeReplicate>[0]) {
  const fake = createFakeReplicate(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerReplicateCommands(program);
  await program.parseAsync(["node", "multix", "replicate", ...args]);
}

describe("parsePreferWaitSeconds", () => {
  it("accepts integers from 1 to 60", () => {
    expect(parsePreferWaitSeconds("1")).toBe(1);
    expect(parsePreferWaitSeconds("60")).toBe(60);
  });

  it("rejects anything else", () => {
    for (const bad of ["0", "61", "1.5", "-5", "", "a cat"]) {
      expect(() => parsePreferWaitSeconds(bad)).toThrow(/1 to 60/);
    }
  });
});

describe("--prefer-wait", () => {
  const route = () => ({
    "POST /models/black-forest-labs/flux-schnell/predictions": [
      { status: 201, json: prediction(ID, "succeeded", { output: "done" }) },
    ],
  });

  it("does not swallow a following prompt: fails on the option, before any request", async () => {
    const fake = stub({});
    const err = await run("image", "--prefer-wait", "a cat").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).code).toBe("commander.invalidArgument");
    expect(output.join("\n")).toContain("--prefer-wait [seconds]");
    expect(output.join("\n")).toContain("1 to 60");
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["0", "61", "1.5"])("rejects the out-of-range value %s", async (bad) => {
    const fake = stub({});
    const err = await run("image", "a cat", "--prefer-wait", bad).catch((e: unknown) => e);
    expect((err as CommanderError).code).toBe("commander.invalidArgument");
    expect(fake.calls).toHaveLength(0);
  });

  it("sends Prefer: wait=N when given a value before the prompt", async () => {
    const fake = stub(route());
    await run("image", "--prefer-wait", "10", "a cat", "--no-download", "--no-webp");
    expect(fake.calls[0]?.headers.prefer).toBe("wait=10");
    expect((fake.calls[0]?.body as { input: { prompt: string } }).input.prompt).toBe("a cat");
  });

  it("treats a bare flag at the end as 60 seconds", async () => {
    const fake = stub(route());
    await run("image", "a cat", "--no-download", "--no-webp", "--prefer-wait");
    expect(fake.calls[0]?.headers.prefer).toBe("wait=60");
  });

  it("treats a bare flag followed by another option as 60 seconds", async () => {
    const fake = stub(route());
    await run("image", "a cat", "--prefer-wait", "--no-download", "--no-webp");
    expect(fake.calls[0]?.headers.prefer).toBe("wait=60");
    expect((fake.calls[0]?.body as { input: { prompt: string } }).input.prompt).toBe("a cat");
  });
});

describe("replicate run --version", () => {
  it("passes --version to the versioned predictions endpoint", async () => {
    const fake = stub({
      "POST /predictions": [{ status: 201, json: prediction(ID, "starting") }],
    });
    await run("run", "owner/model", "--version", "abc123", "--input", '{"x":1}', "--async");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(`${BASE}/predictions`);
    expect(fake.calls[0]?.body).toEqual({ version: "abc123", input: { x: 1 } });
    expect(output.join("\n")).toContain(`Prediction submitted: ${ID}`);
  });
});

describe("replicate status", () => {
  it("exits non-zero for a failed prediction without --wait", async () => {
    const fake = stub({
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "failed", { error: "OOM" }) }],
    });
    await expect(run("status", ID)).rejects.toThrow(ReplicatePredictionError);
    expect(output.join("\n")).toContain('"status": "failed"');
    expect(fake.calls).toHaveLength(1);
  });

  it("prints a resume command for a running prediction and does not poll", async () => {
    const fake = stub({
      [`GET /predictions/${ID}`]: [{ json: prediction(ID, "processing") }],
    });
    await run("status", ID);
    expect(output.join("\n")).toContain(`multix replicate status ${ID} --wait --download`);
    expect(fake.calls).toHaveLength(1);
  });

  it("--download saves outputs of a succeeded prediction", async () => {
    stub({
      [`GET /predictions/${ID}`]: [
        {
          json: prediction(ID, "succeeded", { output: "https://replicate.delivery/x/out.png" }),
        },
      ],
      "GET https://replicate.delivery/x/out.png": [{ bytes: PNG }],
    });
    await run("status", ID, "--download");
    expect(fs.readdirSync(path.join(tmp, "out"))).toEqual(["replicate-pred0001-01.png"]);
  });
});

describe("replicate cancel", () => {
  it("reports a canceled prediction", async () => {
    const fake = stub({
      [`POST /predictions/${ID}/cancel`]: [{ json: prediction(ID, "canceled") }],
    });
    await run("cancel", ID);
    expect(fake.calls[0]?.method).toBe("POST");
    expect(output.join("\n")).toContain(`Prediction ${ID} canceled`);
  });

  it("warns when the prediction already finished", async () => {
    stub({
      [`POST /predictions/${ID}/cancel`]: [{ json: prediction(ID, "succeeded") }],
    });
    await run("cancel", ID);
    expect(output.join("\n")).toContain("already finished (status: succeeded)");
  });

  it("rejects an invalid prediction id before any request", async () => {
    const fake = stub({});
    await expect(run("cancel", "../etc")).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
