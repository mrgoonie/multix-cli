/**
 * multix heygen tts <text> --voice <id> — catalog-voice speech via
 * POST /v3/voices/speech (synchronous; returns an audio URL we download).
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { createHeygenClientFromEnv, downloadOutput, inferExtension } from "../node-helpers.js";
import { buildSpeechRequest } from "../request-builders.js";

interface TtsOpts {
  voice: string;
  ssml?: boolean;
  speed?: string;
  language?: string;
  locale?: string;
  engine?: string;
  output?: string;
  download: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerHeygenTtsCommand(parent: Command): void {
  parent
    .command("tts <text>")
    .description("Text-to-speech with a HeyGen catalog voice (1-5000 characters)")
    .requiredOption("--voice <voice-id>", "Voice ID from `heygen voices`")
    .option("--ssml", "Treat the text as SSML")
    .option("--speed <n>", "Speed multiplier 0.5-2.0")
    .option("--language <code>", "Base language code, e.g. en (auto-detected when omitted)")
    .option("--locale <tag>", "Locale tag for Starfish voices, e.g. zh-HK")
    .option("--engine <e>", "starfish | orca | elevenlabs (defaults to the voice's engine)")
    .option("--output <path>", "Output audio path")
    .option("--no-download", "Print the audio URL instead of downloading")
    .option("--json", "Print a JSON summary")
    .option("-v, --verbose", "Verbose logging")
    .action(async (text: string, opts: TtsOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const body = buildSpeechRequest({
        text,
        voiceId: opts.voice,
        ssml: opts.ssml,
        speed: opts.speed,
        language: opts.language,
        locale: opts.locale,
        engine: opts.engine,
      });
      const client = createHeygenClientFromEnv();
      logger.info("Generating speech...");
      const res = await client.createSpeech(body);

      const summary: Record<string, unknown> = {
        duration: res.duration,
        engine: res.engine,
        request_id: res.request_id ?? null,
        audio_url: redactUrl(res.audio_url),
      };
      if (opts.download === false) {
        if (opts.json)
          console.log(JSON.stringify({ ...summary, audio_url: res.audio_url }, null, 2));
        else console.log(res.audio_url);
        return;
      }
      const ext = inferExtension(res.audio_url, "mp3");
      const name = `heygen-tts-${res.request_id ?? Date.now()}.${ext}`.replace(/[^\w.-]+/g, "-");
      const dest = opts.output ? path.resolve(opts.output) : path.join(getOutputDir(), name);
      await downloadOutput(res.audio_url, dest, "Re-run the command to generate a fresh URL.");
      if (opts.json) console.log(JSON.stringify({ ...summary, file: dest }, null, 2));
      else console.log(`Saved: ${dest} (${res.duration}s, ${res.engine})`);
    });
}
