import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { runCloudflareBytes } from "../client.js";
import { saveBytes } from "../media-output.js";
import { getCloudflareModel } from "../models.js";

export function registerCloudflareSpeechCommand(parent: Command): void {
  parent
    .command("generate-speech")
    .description("Generate MPEG speech with Cloudflare Workers AI MeloTTS")
    .requiredOption("--text <text>", "Text to speak")
    .option("--lang <code>", "MeloTTS language code")
    .option("--model <id>", "Cloudflare TTS model")
    .option("--output <path>", "Save MP3 at this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        text: string;
        lang?: string;
        model?: string;
        output?: string;
        verbose?: boolean;
      }) => {
        if (!opts.text.trim()) throw new ValidationError("--text must not be empty");
        if (opts.lang !== undefined && !opts.lang.trim())
          throw new ValidationError("--lang must not be empty");

        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = getCloudflareModel("speech", opts.model);
        const input: Record<string, unknown> = { prompt: opts.text };
        if (opts.lang) input.lang = opts.lang;

        logger.debug(`Cloudflare speech model=${model}`);
        const bytes = await runCloudflareBytes(model, input);
        const destination = saveBytes(bytes, `cloudflare_speech_${Date.now()}.mp3`, opts.output);
        logger.success(`Saved ${destination}`);
        console.log(destination);
      },
    );
}
