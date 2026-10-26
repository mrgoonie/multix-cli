/**
 * `multix scene` end to end against dist/cli.js: profiles, plan, render,
 * a one-line edit, approval and stem export. A preloaded fake fetch stands in
 * for the providers, so nothing leaves the machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "./child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
// --import takes a URL; a bare Windows path (D:\...) reads as a URL scheme.
const FAKE_FETCH = pathToFileURL(path.resolve(__dirname, "fixtures/fake-speech-fetch.mjs")).href;

describe("scene workflow (smoke)", { timeout: 60_000 }, () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const cli = async (args: string[]) => {
    const result = await execa("node", ["--import", FAKE_FETCH, CLI, ...args, "--json"], {
      reject: false,
      cwd: tmp,
      extendEnv: false,
      env,
      timeout: 15_000,
    });
    if (!result.stdout.trim())
      throw new Error(`no JSON output (exit ${result.exitCode}): ${result.stderr}`);
    return { exitCode: result.exitCode, out: JSON.parse(result.stdout.trim()) };
  };
  const fetchCount = () =>
    fs.existsSync(env.FAKE_FETCH_LOG ?? "")
      ? fs
          .readFileSync(env.FAKE_FETCH_LOG ?? "", "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean).length
      : 0;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-smoke-scene-"));
    env = {
      ...isolatedEnv(tmp),
      MULTIX_HISTORY: "1",
      MULTIX_HISTORY_FILE: path.join(tmp, "h.jsonl"),
      FAKE_FETCH_LOG: path.join(tmp, "fetch.jsonl"),
      OPENAI_API_KEY: "sk-test-not-real",
      ELEVENLABS_API_KEY: "test-not-real",
    };
    fs.writeFileSync(
      path.join(tmp, "s01.txt"),
      "HIRO: Xin chào.\nMAI: Chào anh.\nHIRO: Đi thôi.\n",
    );
    fs.writeFileSync(path.join(tmp, "s02.txt"), "MAI: Mưa rồi.\nHIRO: Ừ.\n");
    fs.writeFileSync(path.join(tmp, "s03.txt"), "HIRO: Hết.\nMAI: Tạm biệt.\nHIRO: Về nhà.\n");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("renders three scenes, re-renders one edited line, approves and exports stems", async () => {
    expect(
      (
        await cli([
          "scene",
          "voice",
          "add",
          "hiro",
          "--provider",
          "openai",
          "--model",
          "gpt-4o-mini-tts",
          "--voice",
          "cedar",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await cli([
          "scene",
          "voice",
          "add",
          "mai",
          "--provider",
          "elevenlabs",
          "--model",
          "eleven_flash_v2_5",
          "--voice",
          "kdmDKE6EkgrWrrykO9Qt",
          "--language",
          "vi-VN",
          "--setting",
          "stability=0.5",
        ])
      ).exitCode,
    ).toBe(0);

    const plan = await cli(["scene", "plan", "s01.txt", "s02.txt", "s03.txt"]);
    expect(plan.out.data).toMatchObject({
      scenes: 3,
      lines: 8,
      cached: 0,
      estimated_cost_usd: null,
    });

    const first = await cli(["scene", "render"]);
    expect(first.exitCode).toBe(0);
    expect(first.out.data.rendered).toHaveLength(8);
    expect(fetchCount()).toBe(8);
    // ElevenLabs reports characters as credits; OpenAI reports nothing (null, not 0).
    const s01 = first.out.data.scenes[0];
    expect(s01).toMatchObject({ scene: "s01", complete: true, cost_usd: null });
    expect(s01.credits).toBeGreaterThan(0);
    const manifest = () => JSON.parse(fs.readFileSync(path.join(tmp, "multix-scene.json"), "utf8"));
    const shas = (m: {
      scenes: Array<{
        lines: Array<{
          id: string;
          selected_take: string;
          takes: Array<{ id: string; sha256: string }>;
        }>;
      }>;
    }) =>
      Object.fromEntries(
        m.scenes
          .flatMap((s) => s.lines)
          .map((l) => [l.id, l.takes.find((t) => t.id === l.selected_take)?.sha256]),
      );
    const before = shas(manifest());

    fs.writeFileSync(path.join(tmp, "s02.txt"), "MAI: Mưa to rồi.\nHIRO: Ừ.\n");
    const second = await cli(["scene", "render"]);
    expect(second.out.data).toMatchObject({ rendered: ["s02/001"], cached: 7, failed: [] });
    expect(fetchCount()).toBe(9);
    const after = shas(manifest());
    for (const id of Object.keys(before)) {
      if (id === "s02/001") expect(after[id]).not.toBe(before[id]);
      else expect(after[id]).toBe(before[id]);
    }

    const approve = await cli(["scene", "approve", "s01/001", "s01/002"]);
    expect(approve.exitCode).toBe(0);
    const strict = await cli(["scene", "export", "--out", "stems", "--approved-only"]);
    expect(strict.exitCode).toBe(2);
    expect(strict.out.error.code).toBe("INVALID_INPUT");

    const exported = await cli(["scene", "export", "--out", "stems"]);
    expect(exported.out.data).toMatchObject({ stems: 8, missing: [] });
    const index = JSON.parse(fs.readFileSync(path.join(tmp, "stems", "scene-export.json"), "utf8"));
    expect(index.schema).toBe("multix.scene-export/v1");
    expect(index.scenes[0].stems[0]).toMatchObject({
      line: "s01/001",
      file: "s01/001_hiro.mp3",
      approved: true,
    });
    expect(fs.existsSync(path.join(tmp, "stems", "s03", "003_hiro.mp3"))).toBe(true);

    // Planning one script adds to the plan; it does not drop the other scenes.
    const subset = await cli(["scene", "plan", "s02.txt"]);
    expect(subset.out.data).toMatchObject({ scenes: 3, to_render: [], removed: [] });
    expect(fs.existsSync(path.join(tmp, "multix-scene.lock"))).toBe(false);

    const status = await cli(["scene", "status"]);
    expect(status.out.data.scenes.map((s: { complete: boolean }) => s.complete)).toEqual([
      true,
      true,
      true,
    ]);

    // The run ledger never holds script text or keys.
    const history = fs.readFileSync(path.join(tmp, "h.jsonl"), "utf8");
    expect(history).not.toContain("Mưa to rồi");
    expect(history).not.toContain("sk-test-not-real");
  });
});
