/**
 * Registers the `gemini` command group and all its subcommands on the root program.
 */

import type { Command } from "commander";
import { registerAnalyzeCommand } from "./analyze.js";
import { registerExtractCommand } from "./extract.js";
import { registerGeminiGenerateSpeechCommand } from "./generate-speech.js";
import { registerGenerateVideoCommand } from "./generate-video.js";
import { registerGenerateCommand } from "./generate.js";
import { registerGeminiImageToVideoCommand } from "./image-to-video.js";
import { registerTranscribeCommand } from "./transcribe.js";

export function registerGeminiCommands(program: Command): void {
  const gemini = program
    .command("gemini")
    .description(
      "Gemini AI operations: analyze, transcribe, extract, generate images/video/speech",
    );

  registerAnalyzeCommand(gemini);
  registerTranscribeCommand(gemini);
  registerExtractCommand(gemini);
  registerGenerateCommand(gemini);
  registerGenerateVideoCommand(gemini);
  registerGeminiImageToVideoCommand(gemini);
  registerGeminiGenerateSpeechCommand(gemini);
}
