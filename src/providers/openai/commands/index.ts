import type { Command } from "commander";
import { registerOpenAIGenerateSpeechCommand } from "./generate-speech.js";
import { registerOpenAIGenerateCommand } from "./generate.js";
import { registerOpenAIImageToImageCommand } from "./image-to-image.js";
import { registerOpenAITranscribeCommand } from "./transcribe.js";

export function registerOpenAICommands(program: Command): void {
  const openai = program
    .command("openai")
    .description(
      "OpenAI: image generation/editing (GPT-Image, Codex driver), text-to-speech (TTS), speech-to-text (STT)",
    );
  registerOpenAIGenerateCommand(openai);
  registerOpenAIImageToImageCommand(openai);
  registerOpenAIGenerateSpeechCommand(openai);
  registerOpenAITranscribeCommand(openai);
}
