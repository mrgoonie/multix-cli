/**
 * Smoke tests — verify each subcommand group responds to --help with exit 0.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
/** Each test spawns `node`; cold starts on slow runners (Windows CI) can exceed vitest's 5 s default. */
const SPAWN_TIMEOUT = 15_000;

/** Spawn `node dist/cli.js`, killed shortly before the test timeout so a hung CLI never outlives its test. */
const run = (args: string[]) =>
  execa("node", [CLI, ...args], { reject: false, timeout: SPAWN_TIMEOUT - 1_000 });

const topLevelCommands = [
  "check",
  "update",
  "gemini",
  "minimax",
  "openrouter",
  "openai",
  "cloudflare",
  "fal",
  "atlas",
  "atlascloud",
  "replicate",
  "heygen",
  "media",
  "doc",
];

const subcommands: Record<string, string[]> = {
  gemini: [
    "analyze",
    "transcribe",
    "extract",
    "generate",
    "generate-video",
    "image-to-image",
    "generate-music",
    "music-live",
  ],
  minimax: ["generate", "generate-video", "generate-speech", "generate-music", "image-to-image"],
  openrouter: ["generate", "image-to-image"],
  openai: ["generate", "image-to-image", "generate-speech", "transcribe"],
  cloudflare: ["generate", "generate-speech", "generate-video", "video-status"],
  fal: ["run", "image", "video", "status", "result"],
  atlas: [
    "image",
    "image-to-image",
    "video",
    "image-to-video",
    "audio",
    "3d",
    "generate-3d",
    "run",
    "status",
    "upload",
  ],
  replicate: ["run", "image", "video", "status", "cancel"],
  heygen: [
    "video-agent",
    "video",
    "status",
    "avatars",
    "voices",
    "styles",
    "languages",
    "me",
    "translate",
    "lipsync",
    "tts",
    "template",
    "model-video",
    "run",
  ],
  media: ["optimize", "split", "batch"],
  doc: ["convert"],
};

describe("top-level --help", { timeout: SPAWN_TIMEOUT }, () => {
  for (const cmd of topLevelCommands) {
    it(`multix ${cmd} --help exits 0`, async () => {
      const result = await run([cmd, "--help"]);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  }
});

describe("subcommand --help", { timeout: SPAWN_TIMEOUT }, () => {
  for (const [group, cmds] of Object.entries(subcommands)) {
    for (const sub of cmds) {
      it(`multix ${group} ${sub} --help exits 0`, async () => {
        const result = await run([group, sub, "--help"]);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
      });
    }
  }
});
