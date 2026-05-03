/**
 * multix gemini generate-speech — text-to-speech with Gemini Flash TTS.
 *
 * Single-speaker by default. Supply 1+ `--speaker name:voice` (max 2) to switch
 * to multi-speaker mode (the prompt text should then prefix lines with
 * `<name>:` so the model can route them).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { type SpeakerVoice, generateGeminiSpeech } from "../generators/speech.js";
import { getDefaultModel } from "../models.js";
import {
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  TTS_OUTPUT_FORMATS,
  TTS_VOICE_DEFAULT,
  type TtsOutputFormat,
  isValidGeminiVoice,
} from "../voices.js";

export function registerGeminiGenerateSpeechCommand(parent: Command): void {
  parent
    .command("generate-speech")
    .description("Generate speech (TTS) with Gemini Flash TTS")
    .option("--text <str>", "Text to speak (use --text or --prompt)")
    .option("--prompt <str>", "Alias for --text")
    .option("--model <id>", `TTS model (${[...GEMINI_TTS_MODELS].join("|")})`)
    .option("--voice <name>", "Prebuilt voice for single-speaker mode", TTS_VOICE_DEFAULT)
    .option(
      "--speaker <name:voice>",
      "Speaker mapping (repeatable, max 2 — switches to multi-speaker mode)",
      collectSpeakers,
      [] as SpeakerVoice[],
    )
    .option("--output-format <fmt>", `Container (${TTS_OUTPUT_FORMATS.join("|")})`, "wav")
    .option("--output <path>", "Copy output audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        text?: string;
        prompt?: string;
        model?: string;
        voice: string;
        speaker: SpeakerVoice[];
        outputFormat: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        const text = opts.text ?? opts.prompt;
        if (!text) throw new ValidationError("Either --text or --prompt is required");

        const model = opts.model ?? getDefaultModel("generate-speech");
        if (!GEMINI_TTS_MODELS.has(model)) {
          throw new ValidationError(`--model must be one of: ${[...GEMINI_TTS_MODELS].join(", ")}`);
        }

        if (!TTS_OUTPUT_FORMATS.includes(opts.outputFormat as TtsOutputFormat)) {
          throw new ValidationError(
            `--output-format must be one of: ${TTS_OUTPUT_FORMATS.join(", ")}`,
          );
        }

        const speakers = opts.speaker;
        if (speakers.length > 2) {
          throw new ValidationError("Gemini TTS supports max 2 speakers in multi-speaker mode");
        }

        // Validate voices in either mode
        if (speakers.length === 0 && !isValidGeminiVoice(opts.voice)) {
          throw new ValidationError(
            `Invalid --voice "${opts.voice}". Valid: ${GEMINI_TTS_VOICES.join(", ")}`,
          );
        }
        for (const sv of speakers) {
          if (!isValidGeminiVoice(sv.voice)) {
            throw new ValidationError(
              `Invalid voice "${sv.voice}" for speaker "${sv.speaker}". Valid: ${GEMINI_TTS_VOICES.join(", ")}`,
            );
          }
        }

        const result = await generateGeminiSpeech({
          text,
          model,
          voice: speakers.length === 0 ? opts.voice : undefined,
          speakers: speakers.length > 0 ? speakers : undefined,
          outputFormat: opts.outputFormat as TtsOutputFormat,
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

/** Commander accumulator for `--speaker name:voice` (repeatable). */
function collectSpeakers(value: string, prev: SpeakerVoice[]): SpeakerVoice[] {
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    throw new ValidationError(`--speaker must be "name:voice" (got "${value}")`);
  }
  const speaker = value.slice(0, idx).trim();
  const voice = value.slice(idx + 1).trim();
  if (!speaker || !voice) {
    throw new ValidationError(`--speaker must be "name:voice" (got "${value}")`);
  }
  return [...prev, { speaker, voice }];
}
