import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { DEFAULT_OPENAI_TTS_MODEL, parseTtsFormat, validateTtsVoice } from "../models.js";
import { generateOpenAISpeech } from "../openai-audio.js";

export function registerOpenAIGenerateSpeechCommand(parent: Command): void {
  parent
    .command("generate-speech")
    .description("Generate speech with OpenAI TTS")
    .option("--text <str>", "Text to speak")
    .option("--prompt <str>", "Alias for --text")
    .option("--model <id>", "TTS model", process.env.OPENAI_TTS_MODEL ?? DEFAULT_OPENAI_TTS_MODEL)
    .option("--voice <name>", "OpenAI voice", "marin")
    .option("--instructions <text>", "Voice/style instructions")
    .option("--output-format <fmt>", "mp3|opus|aac|flac|wav|pcm", "mp3")
    .option("--output <path>", "Copy generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const text = opts.text ?? opts.prompt;
      if (!text) throw new ValidationError("Either --text or --prompt is required");
      validateTtsVoice(opts.voice);
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const dest = await generateOpenAISpeech({
        text,
        model: opts.model,
        voice: opts.voice,
        outputFormat: parseTtsFormat(opts.outputFormat),
        instructions: opts.instructions,
        output: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);
    });
}
