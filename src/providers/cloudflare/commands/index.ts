import type { Command } from "commander";
import { registerCloudflareSpeechCommand } from "./generate-speech.js";
import { registerCloudflareVideoCommand } from "./generate-video.js";
import { registerCloudflareGenerateCommand } from "./generate.js";
import { registerCloudflareVideoStatusCommand } from "./video-status.js";

export function registerCloudflareCommands(program: Command): void {
  const cloudflare = program
    .command("cloudflare")
    .description("Cloudflare Workers AI image and speech, plus AI Gateway video generation");

  registerCloudflareGenerateCommand(cloudflare);
  registerCloudflareSpeechCommand(cloudflare);
  registerCloudflareVideoCommand(cloudflare);
  registerCloudflareVideoStatusCommand(cloudflare);
}
