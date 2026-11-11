#!/usr/bin/env node
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { exitWithError, installAgentRuntime } from "./agent/agent-runtime.js";
import { AGENT_INTRO } from "./commands/agent/agent-intro.js";
import { registerCommands } from "./commands/index.js";
import { loadEnv } from "./core/index.js";
import { isProjectEnvName } from "./project-env-names.js";

// Load .env files before parsing flags so env-dependent defaults work
loadEnv({ isProjectEnvName });

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: JSON import
const pkg = require("../package.json") as any;

const program = new Command()
  .name("multix")
  .description(
    "AI multimodal CLI — image/video/audio/3D generation, editing, transcription, and media processing via OpenAI, Gemini, MiniMax, OpenRouter, Leonardo, BytePlus, ElevenLabs, fal.ai, Atlas Cloud, Replicate, Runway, HeyGen, Sume, TopView, ffmpeg, and ImageMagick",
  )
  // Root options (e.g. --version) are only parsed before the subcommand, so
  // subcommands can define their own --version (multix replicate run --version <id>).
  .enablePositionalOptions();

// `multix -V` prints the bare version on line 1, then where an agent should start.
// This listener must be added before .version() so it runs first and ends the process.
program.on("option:version", () => {
  writeSync(1, `${pkg.version}\n${AGENT_INTRO}`);
  process.exit(0);
});
program.version(pkg.version as string);
program.addHelpText("after", AGENT_INTRO);

registerCommands(program);
// --json, --dry-run, classified errors and the run history for every command.
installAgentRuntime(program, pkg.version as string);

program.parseAsync(process.argv).catch((err: unknown) => exitWithError(err));
