import { Command } from "commander";
import { loadEnv } from "./core/index.js";
import { registerCommands } from "./commands/index.js";
import { createRequire } from "node:module";

// Load .env files before parsing flags so env-dependent defaults work
loadEnv();

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: JSON import
const pkg = require("../package.json") as any;

const program = new Command()
  .name("multix")
  .description("AI multimodal CLI — Gemini · MiniMax · OpenRouter · ffmpeg · ImageMagick · doc-to-md")
  .version(pkg.version as string);

registerCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
