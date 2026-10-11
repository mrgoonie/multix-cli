import { createRequire } from "node:module";
import { Command } from "commander";
import { registerCommands } from "./commands/index.js";
import { loadEnv } from "./core/index.js";

// Load .env files before parsing flags so env-dependent defaults work
loadEnv();

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: JSON import
const pkg = require("../package.json") as any;

const program = new Command()
  .name("multix")
  .description(
    "AI multimodal CLI — image/video/audio/3D generation, editing, transcription, and media processing via OpenAI, Gemini, MiniMax, OpenRouter, Leonardo, BytePlus, ElevenLabs, fal.ai, Atlas Cloud, Replicate, HeyGen, ffmpeg, and ImageMagick",
  )
  .version(pkg.version as string)
  // Root options (e.g. --version) are only parsed before the subcommand, so
  // subcommands can define their own --version (multix replicate run --version <id>).
  .enablePositionalOptions();

registerCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
