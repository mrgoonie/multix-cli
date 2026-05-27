/**
 * Registers the `gemini` command group and all its subcommands on the root program.
 */

import type { Command } from "commander";
import { registerAnalyzeCommand } from "./analyze.js";
import { registerExtractCommand } from "./extract.js";
import { registerGeminiGenerateSpeechCommand } from "./generate-speech.js";
import { registerGenerateVideoCommand } from "./generate-video.js";
import { registerGenerateCommand } from "./generate.js";
import { registerGeminiImageToImageCommand } from "./image-to-image.js";
import { registerGeminiImageToVideoCommand } from "./image-to-video.js";
import { registerTranscribeCommand } from "./transcribe.js";

export function registerGeminiCommands(program: Command): void {
  const gemini = program
    .command("gemini")
    .description(
      "Gemini: analyze, transcribe, extract data, generate images (Imagen/Nano Banana), video (Veo), and speech (Flash TTS)",
    );

  registerAnalyzeCommand(gemini);
  registerTranscribeCommand(gemini);
  registerExtractCommand(gemini);
  registerGenerateCommand(gemini);
  registerGeminiImageToImageCommand(gemini);
  registerGenerateVideoCommand(gemini);
  registerGeminiImageToVideoCommand(gemini);
  registerGeminiGenerateSpeechCommand(gemini);
}
