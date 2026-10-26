/**
 * multix elevenlabs tts — text-to-speech.
 * Endpoint: POST /v1/text-to-speech/{voice_id}?output_format=...
 * Returns audio bytes synchronously; with --timestamps, POST .../with-timestamps
 * returns base64 audio plus character alignment as JSON.
 * Options are checked against the model's capabilities (tts-request.ts).
 */

import fs from "node:fs";
import type { Command } from "commander";
import { ProviderError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, requireElevenLabsKey, saveBytes } from "../client.js";
import {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_OUTPUT_FORMATS,
  TASK_DEFAULTS,
  extFromFormat,
} from "../models.js";
import { type TtsOptions, buildTtsRequest } from "../tts-request.js";

interface TimestampsResponse {
  audio_base64?: string;
  alignment?: unknown;
  normalized_alignment?: unknown;
}

/** `<file>.mp3` → `<file>.alignment.json`. */
function alignmentPath(audioPath: string): string {
  return `${audioPath.replace(/\.[^./\\]+$/, "")}.alignment.json`;
}

export function registerTtsCommand(parent: Command): void {
  parent
    .command("tts")
    .description(
      "Text-to-speech (returns audio synchronously). Options are checked against the model: Eleven v4 uses only --stability, --similarity-boost and --clone-strength",
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
    .option("--stability <n>", "Voice stability 0..1", "0.5")
    .option("--similarity-boost <n>", "Voice similarity boost 0..1", "0.75")
    .option("--style <n>", "Style exaggeration 0..1 (multilingual_v2 only)", "0.0")
    .option("--no-speaker-boost", "Disable speaker boost (multilingual_v2 only; default: enabled)")
    .option(
      "--clone-strength <n>",
      "Professional Voice Clone adherence 0..1 (eleven_v4/eleven_v4_turbo only; 0 recommended)",
    )
    .option(
      "--language-code <code>",
      "ISO 639 language code to enforce (v4, v3, Flash/Turbo v2.5; not multilingual_v2)",
    )
    .option("--seed <n>", "Determinism seed (0..4294967295)")
    .option("--previous-text <str>", "Preceding text for context continuity (not eleven_v3)")
    .option("--next-text <str>", "Following text for context continuity (not eleven_v3)")
    .option("--timestamps", "Also save character timing as <audio>.alignment.json")
    .option("--output <path>", "Copy generated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts, cmd: Command) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const options: TtsOptions = { ...opts, text: opts.text ?? opts.prompt };
      const explicit = new Set(
        (Object.keys(options) as Array<keyof TtsOptions>).filter((k) => {
          const source = cmd.getOptionValueSource(k);
          return source !== undefined && source !== "default";
        }),
      );
      const req = buildTtsRequest(options, explicit);
      for (const w of req.warnings) logger.warn(w);
      const apiKey = requireElevenLabsKey();

      logger.debug(`TTS voice=${opts.voice} model=${opts.model} fmt=${opts.format}`);

      let charged: string | null = null;
      let bytes = await apiPostBinary(req.endpoint, req.payload, apiKey, {
        query: req.query,
        onHeaders: (h) => {
          charged = h.get("character-cost");
        },
      });
      let alignment: string | undefined;
      if (opts.timestamps) {
        let body: TimestampsResponse;
        try {
          body = JSON.parse(bytes.toString("utf8")) as TimestampsResponse;
        } catch {
          body = {};
        }
        if (!body.audio_base64) {
          // Billed already: keep what came back so it can be inspected.
          const raw = saveBytes({ bytes, task: "tts_raw", ext: "bin", logger });
          throw new ProviderError(
            `ElevenLabs returned no audio with timestamps; raw response saved to ${raw}`,
            "elevenlabs",
          );
        }
        bytes = Buffer.from(body.audio_base64, "base64");
        alignment = JSON.stringify(
          { alignment: body.alignment, normalized_alignment: body.normalized_alignment },
          null,
          2,
        );
      }

      const dest = saveBytes({
        bytes,
        task: "tts",
        ext: extFromFormat(opts.format),
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nGenerated audio: ${dest}`);
      if (alignment !== undefined) {
        const files = [dest, ...(opts.output ? [opts.output as string] : [])].map(alignmentPath);
        for (const f of files) fs.writeFileSync(f, alignment);
        console.log(`Alignment: ${files.join(", ")}`);
      }
      if (charged !== null) {
        console.log(`Characters billed (provider-reported character-cost): ${charged}`);
      }
    });
}
