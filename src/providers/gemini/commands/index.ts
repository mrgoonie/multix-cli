/**
 * Registers the `gemini` command group and all its subcommands on the root program.
 */

import type { Command } from "commander";
import { registerAnalyzeCommand } from "./analyze.js";
import { registerTranscribeCommand } from "./transcribe.js";
import { registerExtractCommand } from "./extract.js";
import { registerGenerateCommand } from "./generate.js";
import { registerGenerateVideoCommand } from "./generate-video.js";

export function registerGeminiCommands(program: Command): void {
  const gemini = program
    .command("gemini")
    .description("Gemini AI operations: analyze, transcribe, extract, generate images/video");

  registerAnalyzeCommand(gemini);
  registerTranscribeCommand(gemini);
  registerExtractCommand(gemini);
  registerGenerateCommand(gemini);
  registerGenerateVideoCommand(gemini);
}
