/**
 * multix minimax generate-speech — text-to-speech with MiniMax.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { requireMinimaxKey } from "../client.js";
import { generateMinimaxSpeech } from "../generators/speech.js";
import { MINIMAX_SPEECH_MODELS, SPEECH_FORMATS, TASK_DEFAULTS } from "../models.js";

export function registerMinimaxGenerateSpeechCommand(parent: Command): void {
  parent
    .command("generate-speech")
    .description("Generate speech (TTS) with MiniMax")
    .option("--text <str>", "Text to speak (use --text or --prompt)")
    .option("--prompt <str>", "Alias for --text")
    .option("--model <id>", `Speech model (${[...MINIMAX_SPEECH_MODELS].join("|")})`)
    .option("--voice <id>", "Voice ID", "English_expressive_narrator")
    .option(
      "--emotion <e>",
      "Emotion (neutral|happy|sad|angry|fearful|disgusted|surprised)",
      "neutral",
    )
    .option("--output-format <fmt>", `Audio format (${SPEECH_FORMATS.join("|")})`, "mp3")
    .option("--rate <n>", "Speech rate (0.5–2.0)", "1.0")
    .option("--output <path>", "Copy output audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        text?: string;
        prompt?: string;
        model?: string;
        voice: string;
        emotion: string;
        outputFormat: string;
        rate: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const apiKey = requireMinimaxKey();

        const text = opts.text ?? opts.prompt;
        if (!text) throw new ValidationError("Either --text or --prompt is required");

        if (!SPEECH_FORMATS.includes(opts.outputFormat as (typeof SPEECH_FORMATS)[number])) {
          throw new ValidationError(`--output-format must be one of: ${SPEECH_FORMATS.join(", ")}`);
        }

        const model = opts.model ?? TASK_DEFAULTS.speech;
        const rate = Number.parseFloat(opts.rate);

        const result = await generateMinimaxSpeech({
          apiKey,
          text,
          model,
          voice: opts.voice,
          emotion: opts.emotion,
          outputFormat: opts.outputFormat,
          rate,
          output: opts.output,
          logger,
        });

        if (result.status === "error") {
          logger.error(result.error ?? "Unknown error");
          process.exit(1);
        }

        console.log(`\nGenerated audio: ${result.generatedAudio}`);
      },
    );
}
