/**
 * Smoke tests — verify each subcommand group responds to --help with exit 0.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { CHILD_TIMEOUT, SPAWN_TIMEOUT } from "./spawn-timeout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");
const run = (args: string[]) =>
  execa("node", [CLI, ...args], { reject: false, timeout: CHILD_TIMEOUT });

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
  gemini: ["analyze", "transcribe", "extract", "generate", "generate-video", "image-to-image"],
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
      expect(result.exitCode).toBe(0);
    });
  }
});

describe("subcommand --help", { timeout: SPAWN_TIMEOUT }, () => {
  for (const [group, cmds] of Object.entries(subcommands)) {
    for (const sub of cmds) {
      it(`multix ${group} ${sub} --help exits 0`, async () => {
        const result = await run([group, sub, "--help"]);
        expect(result.exitCode).toBe(0);
      });
    }
  }
});
