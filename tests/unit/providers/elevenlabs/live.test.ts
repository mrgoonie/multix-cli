/**
 * Optional paid smoke test against the real ElevenLabs API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and ELEVENLABS_API_KEY are set. Runs the built CLI
 * (`npm run build` first) once per Eleven v4 variant with "Hi." — about 5
 * characters in total (v4: 3, v4 Turbo: 2 at its 0.5x rate) — and never
 * prints the key.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(process.env.ELEVENLABS_API_KEY);
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../dist/cli.js");

describe.skipIf(!enabled)("elevenlabs live smoke", () => {
  it.each(["eleven_v4", "eleven_v4_turbo"])(
    "%s returns audio and a provider-reported character cost",
    (model) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elevenlabs-live-"));
      try {
        const stdout = execFileSync(
          process.execPath,
          [cli, "elevenlabs", "tts", "--json", "--text", "Hi.", "--model", model, "--timestamps"],
          {
            encoding: "utf8",
            env: { ...process.env, MULTIX_OUTPUT_DIR: dir, MULTIX_HISTORY: "0" },
          },
        );
        const result = JSON.parse(stdout);
        expect(result.ok).toBe(true);
        expect(result.model).toBe(model);
        expect(result.usage.credits).toBeGreaterThan(0);
        expect(result.usage.metrics["header.character-cost"]).toBe(result.usage.credits);
        const files = fs.readdirSync(dir);
        const audio = files.find((f) => f.endsWith(".mp3"));
        expect(audio).toBeDefined();
        expect(fs.statSync(path.join(dir, audio as string)).size).toBeGreaterThan(1000);
        expect(files.some((f) => f.endsWith(".alignment.json"))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
