/**
 * Registers the `gemini` command group and all its subcommands on the root program.
 */

import type { Command } from "commander";
import { registerAnalyzeCommand } from "./analyze.js";
import { registerGeminiEditVideoCommands } from "./edit-video.js";
import { registerExtractCommand } from "./extract.js";
import { registerGeminiGenerateMusicCommands } from "./generate-music.js";
import { registerGeminiGenerateSpeechCommand } from "./generate-speech.js";
import { registerGenerateVideoCommand } from "./generate-video.js";
import { registerGenerateCommand } from "./generate.js";
import { registerGeminiImageToImageCommand } from "./image-to-image.js";
import { registerGeminiImageToVideoCommand } from "./image-to-video.js";
import { registerTranscribeCommand } from "./transcribe.js";
import { registerGeminiVideoStatusCommands } from "./video-status.js";

export function registerGeminiCommands(program: Command): void {
  const gemini = program
    .command("gemini")
    .description(
      "Gemini: analyze, transcribe, extract data, generate images (Nano Banana), video (Omni Flash, Veo), speech (Flash TTS) and music (Lyria)",
    );

  registerAnalyzeCommand(gemini);
  registerTranscribeCommand(gemini);
  registerExtractCommand(gemini);
  registerGenerateCommand(gemini);
  registerGeminiImageToImageCommand(gemini);
  registerGenerateVideoCommand(gemini);
  registerGeminiImageToVideoCommand(gemini);
  registerGeminiEditVideoCommands(gemini);
  registerGeminiVideoStatusCommands(gemini);
  registerGeminiGenerateSpeechCommand(gemini);
  registerGeminiGenerateMusicCommands(gemini);
}
