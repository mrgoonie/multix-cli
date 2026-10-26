/**
 * Optional live smoke test of `multix fal tts` against the real fal queue.
 * Skipped unless MULTIX_LIVE_TESTS=1 and FAL_KEY are set. Speaks one short
 * sentence on Gemini 3.8 Flash-Lite TTS (WAV) and ElevenLabs v4 Turbo (MP3)
 * and checks the saved file is real audio of the expected type.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import { registerFalCommands } from "../../../../src/providers/fal/commands/index.js";

const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(process.env.FAL_KEY);
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-tts-live-"));

afterAll(() => fs.rmSync(outRoot, { recursive: true, force: true }));

async function tts(model: string, outDir: string): Promise<string[]> {
  const program = new Command();
  program.exitOverride();
  registerFalCommands(program);
  await program.parseAsync([
    "node",
    "multix",
    "fal",
    "tts",
    "Hello from multix.",
    "-m",
    model,
    "--output-dir",
    outDir,
  ]);
  return fs.readdirSync(outDir).map((f) => path.join(outDir, f));
}

describe.skipIf(!enabled)("fal tts live smoke", () => {
  it.each([
    [
      "google/gemini-3.8-flash-lite-tts",
      ".wav",
      (b: Buffer) => b.subarray(0, 4).toString() === "RIFF",
    ],
    [
      "elevenlabs/tts/eleven-v4-turbo",
      ".mp3",
      (b: Buffer) =>
        b.subarray(0, 3).toString() === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
    ],
  ])(
    "%s saves %s audio",
    async (model, ext, isAudio) => {
      const dir = path.join(outRoot, model.replace(/\W+/g, "-"));
      const files = await tts(model, dir);
      expect(files).toHaveLength(1);
      expect(path.extname(files[0] ?? "")).toBe(ext);
      const bytes = fs.readFileSync(files[0] ?? "");
      expect(bytes.length).toBeGreaterThan(1000);
      expect(isAudio(bytes)).toBe(true);
    },
    300_000,
  );
});
