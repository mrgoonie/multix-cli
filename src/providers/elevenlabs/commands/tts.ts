/**
 * multix elevenlabs tts — text-to-speech.
 * Endpoint: POST /v1/text-to-speech/{voice_id}[/with-timestamps]?output_format=...
 * Returns audio bytes synchronously (or JSON with base64 audio and alignment).
 */

import fs from "node:fs";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinaryWithHeaders, requireElevenLabsKey, saveBytes } from "../client.js";
import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_OUTPUT_FORMATS,
  TASK_DEFAULTS,
  extFromFormat,
} from "../models.js";
import { TTS_VOICE_DEFAULTS, buildTtsRequest, checkVoiceId } from "../tts-request.js";

interface TimestampsResp {
  audio_base64?: string;
  alignment?: unknown;
  normalized_alignment?: unknown;
}

export function registerTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description(
      "Text-to-speech (returns audio synchronously). Options a model cannot honour are rejected or reported, never dropped silently",
    )
    .option("--text <str>", "Text to speak (use --text or --prompt)")
    .option("--prompt <str>", "Alias for --text")
    .option("--voice <id>", "Voice ID", TASK_DEFAULTS.ttsVoice)
    .option(
      "--model <id>",
      `TTS model (${[...ELEVENLABS_TTS_MODELS].join("|")})`,
      TASK_DEFAULTS.ttsModel,
    )
    .option(
      "--format <fmt>",
      `Output format (${[...ELEVENLABS_TTS_OUTPUT_FORMATS].join("|")})`,
      TASK_DEFAULTS.ttsFormat,
    )
    .option("--stability <n>", `Voice stability 0..1 (default ${TTS_VOICE_DEFAULTS.stability})`)
    .option(
      "--similarity-boost <n>",
      `Voice similarity boost 0..1 (default ${TTS_VOICE_DEFAULTS.similarityBoost})`,
    )
    .option(
      "--style <n>",
      `Style exaggeration 0..1 (default ${TTS_VOICE_DEFAULTS.style}; eleven_multilingual_v2 only)`,
    )
    .option(
      "--no-speaker-boost",
      "Disable speaker boost (default: enabled on models that have it: eleven_multilingual_v2, eleven_v3_conversational)",
    )
    .option(
      "--clone-strength <n>",
      "Professional Voice Clone adherence 0..1 (eleven_v4, eleven_v4_turbo only)",
    )
    .option(
      "--language-code <code>",
      "ISO 639-1 language code to enforce (the API rejects codes a model does not support)",
    )
    .option("--seed <n>", "Determinism seed (0..4294967295, best effort)")
    .option("--previous-text <str>", "Preceding text for context continuity (not eleven_v3)")
    .option("--next-text <str>", "Following text for context continuity (not eleven_v3)")
    .option(
      "--timestamps",
      "Also save character timings (<audio>.timestamps.json) via /with-timestamps",
    )
    .option("--output <path>", "Copy generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts, cmd: Command) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      const text = opts.text ?? opts.prompt;
      if (!text) throw new ValidationError("Either --text or --prompt is required");
      if (!opts.voice) throw new ValidationError("--voice <id> is required");
      checkVoiceId(opts.voice);

      const { payload, warnings } = buildTtsRequest({
        text,
        model: opts.model,
        stability: opts.stability,
        similarityBoost: opts.similarityBoost,
        style: opts.style,
        speakerBoost:
          cmd.getOptionValueSource("speakerBoost") === "cli" ? opts.speakerBoost : undefined,
        cloneStrength: opts.cloneStrength,
        languageCode: opts.languageCode,
        seed: opts.seed,
        previousText: opts.previousText,
        nextText: opts.nextText,
      });
      for (const w of warnings) logger.warn(w);
      const apiKey = requireElevenLabsKey();

      logger.debug(`TTS voice=${opts.voice} model=${opts.model} fmt=${opts.format}`);

      const endpoint = `text-to-speech/${encodeURIComponent(opts.voice)}${opts.timestamps ? "/with-timestamps" : ""}`;
      const res = await apiPostBinaryWithHeaders(endpoint, payload, apiKey, {
        query: { output_format: opts.format },
      });

      // Only what ElevenLabs reports; multix never estimates what was charged.
      const charged = res.headers.get("character-cost");
      const reportCharged = () => {
        if (charged !== null && charged.trim() !== "") {
          console.log(`Credits charged (ElevenLabs character-cost header): ${charged}`);
        }
      };

      let bytes = res.bytes;
      let timings: TimestampsResp | undefined;
      if (opts.timestamps) {
        let parsed: TimestampsResp | null | undefined;
        try {
          parsed = JSON.parse(res.bytes.toString("utf8")) as TimestampsResp | null;
        } catch {}
        if (typeof parsed?.audio_base64 !== "string" || parsed.audio_base64 === "") {
          // The request was billed: keep what came back so it can be inspected.
          const raw = saveBytes({ bytes: res.bytes, task: "tts_raw", ext: "bin", logger });
          reportCharged();
          throw new ProviderError(
            `with-timestamps response ${parsed === undefined ? "was not JSON" : "carried no audio"}; raw response saved to ${raw}`,
            "elevenlabs",
          );
        }
        timings = parsed;
        bytes = Buffer.from(parsed.audio_base64, "base64");
      }

      const dest = saveBytes({
        bytes,
        task: "tts",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);

      if (timings) {
        const json = `${JSON.stringify(
          { alignment: timings.alignment, normalized_alignment: timings.normalized_alignment },
          null,
          2,
        )}\n`;
        // Next to the saved audio and next to the --output copy, like the audio itself.
        for (const audio of opts.output ? [dest, opts.output] : [dest]) {
          fs.writeFileSync(`${audio}.timestamps.json`, json);
          console.log(`Timestamps: ${audio}.timestamps.json`);
        }
      }

      reportCharged();
    });
}
