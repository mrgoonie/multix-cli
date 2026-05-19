import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import {
  checkCodexAuthenticated,
  runCodexImageGeneration,
  sanitizeCodexEnv,
} from "../../../../src/providers/openai/codex-image-driver.js";

describe("Codex image driver", () => {
  const originalEnv = { ...process.env };
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-codex-test-"));
    process.env.MULTIX_OUTPUT_DIR = tmp;
    process.env.OPENAI_API_KEY = "secret";
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";
    _resetOutputDir();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetOutputDir();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects ChatGPT auth from codex login status", async () => {
    const ok = await checkCodexAuthenticated(async () => ({
      stdout: "Logged in using ChatGPT",
      stderr: "",
      exitCode: 0,
    }));
    expect(ok).toBe(true);
  });

  it("does not pass arbitrary API keys into Codex", () => {
    const env = sanitizeCodexEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes output schema and validates generated file", async () => {
    const saved = await runCodexImageGeneration({
      prompt: "red square",
      outputFormat: "png",
      runner: async (_cmd, args) => {
        expect(args).toContain("--output-schema");
        const prompt = args.at(-1) ?? "";
        const match = /at (.+?\.png)/.exec(prompt);
        if (!match?.[1]) throw new Error("output path missing in prompt");
        fs.writeFileSync(match[1], "png");
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    });
    expect(fs.existsSync(saved.path)).toBe(true);
  });

  it("rejects missing output file", async () => {
    await expect(
      runCodexImageGeneration({
        prompt: "red square",
        outputFormat: "png",
        runner: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      }),
    ).rejects.toThrow(/did not create/);
  });
});
