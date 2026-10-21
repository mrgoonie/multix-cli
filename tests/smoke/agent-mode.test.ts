/**
 * Agent mode smoke tests: the --json envelope, --dry-run (no request leaves the
 * machine), exit-code classes, and the run ledger, against dist/cli.js.
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
const SPAWN_TIMEOUT = 15_000;

describe("agent mode (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execa("node", [CLI, ...args], {
      reject: false,
      cwd: tmp,
      extendEnv: false,
      env: { ...env, ...extra },
      timeout: SPAWN_TIMEOUT - 1_000,
    });
  const envelope = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "{}");
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-agent-"));
    env = {
      ...isolatedEnv(tmp),
      MULTIX_HISTORY: "1",
      MULTIX_HISTORY_FILE: path.join(tmp, "h.jsonl"),
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("prints one envelope with a usage class for a parse error", async () => {
    const result = await run(["gemini", "generate", "--json"]);
    expect(result.exitCode).toBe(2);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({
      schema: "multix.result/v1",
      ok: false,
      command: "gemini generate",
      provider: "gemini",
    });
    expect(out.error.retryable).toBe(false);
    expect(out.next).toContain("multix gemini generate --help");
  });

  it("reports a missing key with exit 3 and the env name", async () => {
    const result = await run(["fal", "image", "a cat", "--json"], { FAL_KEY: "" });
    expect(result.exitCode).toBe(3);
    const out = envelope(result.stdout);
    expect(out.error).toMatchObject({ code: "MISSING_KEY", env: "FAL_KEY" });
    expect(out.next).toContain("multix check");
  });

  it("dry run shows the first request without sending it or the key", async () => {
    const result = await run(["fal", "image", "a cat", "--dry-run", "--json"], {
      FAL_KEY: "test-key-not-real",
      // Any real request would fail fast instead of hanging.
      HTTPS_PROXY: "http://127.0.0.1:9",
    });
    expect(result.exitCode).toBe(0);
    const out = envelope(result.stdout);
    expect(out).toMatchObject({ ok: true, dry_run: true, outputs: [] });
    expect(out.request.method).toBe("POST");
    expect(out.request.url).toMatch(/^https:\/\/[^?]+$/);
    expect(result.stdout).not.toContain("test-key-not-real");
    expect(out.next[0]).toBe("multix fal image 'a cat' --json");
  });

  it("records runs in the ledger and shows them with history", async () => {
    await run(["fal", "image", "--help"]); // help is not a run
    await run(["fal", "image", "a cat"], { FAL_KEY: "" });
    const list = await run(["history", "--json"]);
    expect(list.exitCode).toBe(0);
    const rows = envelope(list.stdout).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: "fal image",
      provider: "fal",
      ok: false,
      exit_code: 1, // plain runs keep exit 1; the class is in error.code
      error: { code: "MISSING_KEY" },
    });
    const show = await run(["history", "show", "last"]);
    expect(JSON.parse(show.stdout).id).toBe(rows[0].id);
    // rerun forwards --dry-run to the recorded command instead of spending again.
    const again = await run(["rerun", "last", "--dry-run", "--json"], {
      FAL_KEY: "test-key-not-real",
      HTTPS_PROXY: "http://127.0.0.1:9",
    });
    expect(again.exitCode).toBe(0);
    expect(envelope(again.stdout)).toMatchObject({ dry_run: true, command: "fal image" });
  });

  it("keeps exit 1 without --json but prints the code, hint and next steps", async () => {
    const result = await run(["fal", "image", "a cat"], { FAL_KEY: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code: MISSING_KEY (exit 3 with --json)");
    expect(result.stderr).toContain("next: multix check");
  });

  it("lists models by task as JSON and in the guide", async () => {
    const models = await run(["models", "--task", "speech", "--json"]);
    expect(models.exitCode).toBe(0);
    const rows = envelope(models.stdout).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { task: string }) => r.task === "speech")).toBe(true);
    const guide = await run(["guide"]);
    expect(guide.stdout).toContain("multix.result/v1");
  });
});
