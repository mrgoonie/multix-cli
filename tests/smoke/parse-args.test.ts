/**
 * Smoke tests — verify each subcommand group responds to --help with exit 0.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");

const topLevelCommands = ["check", "gemini", "minimax", "openrouter", "media", "doc"];

const subcommands: Record<string, string[]> = {
  gemini: ["analyze", "transcribe", "extract", "generate", "generate-video"],
  minimax: ["generate", "generate-video", "generate-speech", "generate-music"],
  openrouter: ["generate"],
  media: ["optimize", "split", "batch"],
  doc: ["convert"],
};

describe("top-level --help", () => {
  for (const cmd of topLevelCommands) {
    it(`multix ${cmd} --help exits 0`, async () => {
      const result = await execa("node", [CLI, cmd, "--help"], { reject: false });
      expect(result.exitCode).toBe(0);
    });
  }
});

describe("subcommand --help", () => {
  for (const [group, cmds] of Object.entries(subcommands)) {
    for (const sub of cmds) {
      it(`multix ${group} ${sub} --help exits 0`, async () => {
        const result = await execa("node", [CLI, group, sub, "--help"], { reject: false });
        expect(result.exitCode).toBe(0);
      });
    }
  }
});
