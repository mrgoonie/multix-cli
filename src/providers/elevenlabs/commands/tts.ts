/**
 * multix elevenlabs tts — text-to-speech.
 * Endpoint: POST /v1/text-to-speech/{voice_id}[/with-timestamps]?output_format=...
 * Returns audio bytes (or audio + character alignment JSON) synchronously.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey, saveBytes } from "../client.js";
import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_OUTPUT_FORMATS,
  TASK_DEFAULTS,
  extFromFormat,
} from "../models.js";
import { type VoiceSettings, buildTtsRequest, parseSetting } from "../tts-request.js";

interface TimestampsResp {
  audio_base64?: string;
  alignment?: unknown;
  normalized_alignment?: unknown;
}

export function registerTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description(
      "Text-to-speech (returns audio synchronously). Voice settings a model ignores are rejected.",
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
    .option("--stability <n>", "Voice stability 0..1 (v2/v3 default 0.5; v4: voice's stored value)")
    .option(
      "--similarity-boost <n>",
      "Voice similarity 0..1 (v2/v3 default 0.75; v4: voice's stored value)",
    )
    .option("--style <n>", "Style exaggeration 0..1 (eleven_multilingual_v2 only)")
    .option("--speed <n>", "Speech speed 0.7..1.2 (v2 models only; v3/v4 ignore speed)")
    .option(
      "--clone-strength <n>",
      "Professional Voice Clone adherence 0..1 (eleven_v4/eleven_v4_turbo only)",
    )
    .option("--speaker-boost", "Enable speaker boost (multilingual_v2, v3_conversational)")
    .option("--no-speaker-boost", "Disable speaker boost")
    .option("--language-code <code>", "ISO 639-1 language code (not eleven_multilingual_v2)")
    .option("--seed <n>", "Determinism seed (0..4294967295)")
    .option("--previous-text <str>", "Preceding text for context continuity")
    .option("--next-text <str>", "Following text for context continuity")
    .option("--timestamps", "Also save character-level timing as <audio>.alignment.json")
    .option("--output <path>", "Copy generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts, cmd: Command) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });

      const text = opts.text ?? opts.prompt;
      if (!text) throw new ValidationError("Either --text or --prompt is required");
      if (!opts.voice) throw new ValidationError("--voice <id> is required");
      if (!(ELEVENLABS_TTS_OUTPUT_FORMATS as readonly string[]).includes(opts.format)) {
        throw new ValidationError(
          `Invalid --format: ${opts.format}. Valid: ${ELEVENLABS_TTS_OUTPUT_FORMATS.join(", ")}`,
        );
      }

      const settings: VoiceSettings = {};
      const numeric = [
        ["stability", "--stability", opts.stability],
        ["similarity_boost", "--similarity-boost", opts.similarityBoost],
        ["style", "--style", opts.style],
        ["speed", "--speed", opts.speed],
        ["clone_strength", "--clone-strength", opts.cloneStrength],
      ] as const;
      for (const [key, flag, raw] of numeric) {
        const value = parseSetting(flag, raw);
        if (value !== undefined) settings[key] = value;
      }
      if (cmd.getOptionValueSource("speakerBoost") === "cli") {
        settings.use_speaker_boost = opts.speakerBoost;
      }
      const seed = parseSetting("--seed", opts.seed);

      const { payload, warnings } = buildTtsRequest({
        text,
        model: opts.model,
        settings,
        languageCode: opts.languageCode,
        seed,
        previousText: opts.previousText,
        nextText: opts.nextText,
      });
      for (const w of warnings) logger.warn(w);

      const apiKey = requireElevenLabsKey();
      logger.debug(`TTS voice=${opts.voice} model=${opts.model} fmt=${opts.format}`);

      let headers: Headers | undefined;
      const endpoint = `text-to-speech/${opts.voice}${opts.timestamps ? "/with-timestamps" : ""}`;
      const body = await apiPostBinary(endpoint, payload, apiKey, {
        query: { output_format: opts.format },
        onHeaders: (h) => {
          headers = h;
        },
      });

      let bytes = body;
      let alignment: TimestampsResp | undefined;
      if (opts.timestamps) {
        try {
          alignment = JSON.parse(body.toString("utf8")) as TimestampsResp;
        } catch {
          alignment = {};
        }
        if (!alignment.audio_base64) {
          throw new ProviderError(
            "ElevenLabs returned no audio_base64 in the with-timestamps response",
            "elevenlabs",
          );
        }
        bytes = Buffer.from(alignment.audio_base64, "base64");
      }

      const dest = saveBytes({
        bytes,
        task: "tts",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);

      if (alignment) {
        const alignmentPath = dest.replace(/\.[^.]+$/, ".alignment.json");
        fs.writeFileSync(
          alignmentPath,
          JSON.stringify(
            {
              alignment: alignment.alignment ?? null,
              normalized_alignment: alignment.normalized_alignment ?? null,
            },
            null,
            2,
          ),
        );
        console.log(`Alignment: ${alignmentPath}`);
      }

      // Provider-reported billing, never an estimate: the character-cost header.
      const charCost = headers?.get("character-cost");
      if (charCost) {
        const requestId = headers?.get("request-id");
        console.log(
          `Billed by ElevenLabs: ${charCost} characters (character-cost header${
            requestId ? `, request-id ${requestId}` : ""
          })`,
        );
      }
    });
}
