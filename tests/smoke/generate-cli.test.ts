/**
 * `multix generate` against dist/cli.js: a dry run goes through the provider
 * command and its envelope names the route, and an input the provider cannot
 * take is refused with CONFIG_ERROR (exit 3) before any request. A fake key is
 * used and nothing is sent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");

describe("generate (smoke)", { timeout: 15_000 }, () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-generate-smoke-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const cli = (...args: string[]) =>
    execa("node", [CLI, ...args], {
      env: { ...isolatedEnv(tmp), FAL_KEY: "test-not-a-key", MULTIX_CACHE_DIR: tmp },
      extendEnv: false,
      reject: false,
    });

  it("dry-runs through the provider command and reports the route", async () => {
    const r = await cli(
      "generate",
      "image",
      "a fox",
      "--provider",
      "fal",
      "--aspect-ratio",
      "16:9",
      "--dry-run",
      "--json",
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      schema: "multix.result/v1",
      ok: true,
      command: "fal image",
      dry_run: true,
      route: { via: "generate", task: "image", provider: "fal", command: "fal image" },
      request: { body: { prompt: "a fox", image_size: "landscape_16_9" } },
    });
  });

  it("refuses an unsupported task before any request", async () => {
    const r = await cli("generate", "upscale", "--provider", "fal", "--image", "a.png", "--json");
    expect(r.exitCode).toBe(3);
    const out = JSON.parse(r.stdout);
    expect(out.error.code).toBe("CONFIG_ERROR");
    expect(out.error.message).toMatch(/leonardo/);
  });
});
