/**
 * Registers the `openrouter` command group.
 */

import type { Command } from "commander";
import { registerOpenRouterGenerateCommand } from "./generate.js";
import { registerOpenRouterGenerationCommand } from "./generation.js";
import { registerOpenRouterImageToImageCommand } from "./image-to-image.js";
import { registerOpenRouterImageToVideoCommand } from "./image-to-video.js";
import { registerOpenRouterSpeechModelsCommand } from "./speech-models.js";
import { registerOpenRouterTtsCommand } from "./tts.js";
import { registerOpenRouterVideoModelsCommand } from "./video-models.js";
import { registerOpenRouterVideoStatusCommand } from "./video-status.js";

export function registerOpenRouterCommands(program: Command): void {
  const openrouter = program
    .command("openrouter")
    .description(
      "OpenRouter: text-to-image, image-to-image, video generation (image-to-video) and text-to-speech via routed models — Veo, Seedance, Kling, Gemini TTS, ElevenLabs, Fish Audio, and others",
    );

  registerOpenRouterGenerateCommand(openrouter);
  registerOpenRouterImageToImageCommand(openrouter);
  registerOpenRouterImageToVideoCommand(openrouter);
  registerOpenRouterVideoStatusCommand(openrouter);
  registerOpenRouterVideoModelsCommand(openrouter);
  registerOpenRouterTtsCommand(openrouter);
  registerOpenRouterSpeechModelsCommand(openrouter);
  registerOpenRouterGenerationCommand(openrouter);
}
