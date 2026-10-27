#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { exitWithError, installAgentRuntime } from "./agent/agent-runtime.js";
import { settleTelemetry } from "./agent/fetch-telemetry.js";
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
    "AI multimodal CLI — image/video/audio/3D generation, editing, transcription, and media processing via OpenAI, Gemini, MiniMax, OpenRouter, Leonardo, BytePlus, ElevenLabs, fal.ai, Atlas Cloud, Replicate, Runway, HeyGen, ffmpeg, and ImageMagick",
  )
  .version(pkg.version as string)
  // Root options (e.g. --version) are only parsed before the subcommand, so
  // subcommands can define their own --version (multix replicate run --version <id>).
  .enablePositionalOptions();

registerCommands(program);
// --json, --dry-run, classified errors and the run history for every command.
installAgentRuntime(program, pkg.version as string);

program.parseAsync(process.argv).catch(async (err: unknown) => {
  // A failure right after a response still reports the usage, model and job it carried.
  await settleTelemetry();
  exitWithError(err);
});
