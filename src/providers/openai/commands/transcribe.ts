import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { DEFAULT_OPENAI_STT_MODEL, parseTranscriptFormat } from "../models.js";
import { transcribeOpenAIAudio } from "../openai-audio.js";

export function registerOpenAITranscribeCommand(parent: Command): void {
  parent
    .command("transcribe")
    .description("Transcribe audio/video with OpenAI STT")
    .requiredOption("--input <path>", "Audio or video file")
    .option("--model <id>", "STT model", process.env.OPENAI_STT_MODEL ?? DEFAULT_OPENAI_STT_MODEL)
    .option("--format <fmt>", "json|text|diarized_json", "text")
    .option("--language <code>", "ISO language code")
    .option("--chunking-strategy <strategy>", "e.g. auto")
    .option(
      "--known-speaker-name <name>",
      "Known speaker name; repeatable",
      collect,
      [] as string[],
    )
    .option(
      "--known-speaker-reference <path>",
      "2-10s reference audio; repeatable",
      collect,
      [] as string[],
    )
    .option("--output <path>", "Save transcript to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const result = await transcribeOpenAIAudio({
        inputPath: opts.input,
        model: opts.model,
        format: parseTranscriptFormat(opts.format),
        language: opts.language,
        chunkingStrategy: opts.chunkingStrategy,
        knownSpeakerNames: opts.knownSpeakerName,
        knownSpeakerReferences: opts.knownSpeakerReference,
        output: opts.output,
        logger,
      });
      if (opts.format === "text" && result.text) console.log(`\n${result.text.trim()}`);
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
