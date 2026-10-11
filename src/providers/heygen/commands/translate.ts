/**
 * multix heygen translate <source> --languages "Spanish (Spain),English"
 * Video translation via POST /v3/video-translations. One job ID per target
 * language; each is polled and downloaded independently.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import {
  type WaitFlowOptions,
  addWaitOptions,
  completeJobs,
  createHeygenClientFromEnv,
  resolveMediaInput,
} from "../node-helpers.js";
import { checkCallback, numberInRange, qualityMode, splitLanguages } from "../request-builders.js";
import type { CreateVideoTranslationRequest } from "../types.js";

interface TranslateOpts extends WaitFlowOptions {
  languages: string;
  mode?: string;
  inputLanguage?: string;
  audioOnly?: boolean;
  audio?: string;
  speakers?: string;
  keepFormat?: boolean;
  dynamicDuration?: boolean;
  disableMusic?: boolean;
  enhanceSpeech?: boolean;
  start?: string;
  end?: string;
  brandGlossary?: string;
  title?: string;
  folder?: string;
  callbackUrl?: string;
  callbackId?: string;
}

export function registerHeygenTranslateCommand(parent: Command): void {
  const cmd = parent
    .command("translate <source>")
    .description(
      "Translate a video (voice clone + lip-sync). Source: https:// URL, asset:<id>, or local file",
    )
    .requiredOption(
      "--languages <list>",
      'Comma-separated target language names from `heygen languages`, e.g. "Spanish (Spain),English"',
    )
    .option("--mode <m>", "speed (default) | precision (higher lip-sync quality)")
    .option("--input-language <code>", "Source language (auto-detected when omitted)")
    .option("--audio-only", "Translate audio only and keep the original video frames")
    .option("--audio <ref>", "Custom dubbing audio: https:// URL, asset:<id>, or file")
    .option("--speakers <n>", "Number of speakers (improves separation)")
    .option("--keep-format", "Preserve source resolution/bitrate")
    .option("--no-dynamic-duration", "Disable dynamic duration adjustment")
    .option("--disable-music", "Remove the background music track")
    .option("--enhance-speech", "Enhance speech quality")
    .option("--start <s>", "Start time in seconds (partial translation)")
    .option("--end <s>", "End time in seconds (partial translation)")
    .option("--brand-glossary <id>", "Brand glossary ID (term translations)")
    .option("--title <text>", "Job title")
    .option("--folder <id>", "Destination folder ID")
    .option("--callback-url <url>", "HTTPS webhook URL notified on completion")
    .option("--callback-id <id>", "Caller ID echoed in the webhook payload");
  addWaitOptions(cmd).action(async (source: string, opts: TranslateOpts) => {
    const logger = createLogger({ verbose: opts.verbose ?? false });
    const languages = splitLanguages(opts.languages);
    const mode = qualityMode(opts.mode);
    const speakers = numberInRange(opts.speakers, "--speakers", 1, 100, true);
    const start = numberInRange(opts.start, "--start", 0, Number.MAX_SAFE_INTEGER);
    const end = numberInRange(opts.end, "--end", 0, Number.MAX_SAFE_INTEGER);
    if (start !== undefined && end !== undefined && end <= start) {
      throw new ValidationError("--end must be greater than --start");
    }
    const callbackUrl = checkCallback(opts.callbackUrl);

    const client = createHeygenClientFromEnv();
    const video = await resolveMediaInput(client, source, logger);
    const audio = opts.audio ? await resolveMediaInput(client, opts.audio, logger) : undefined;

    const body: CreateVideoTranslationRequest = { video, output_languages: languages };
    if (audio) body.audio = audio;
    if (mode) body.mode = mode;
    if (opts.inputLanguage) body.input_language = opts.inputLanguage;
    if (opts.audioOnly) body.translate_audio_only = true;
    if (speakers !== undefined) body.speaker_num = speakers;
    if (opts.keepFormat) body.keep_the_same_format = true;
    if (opts.dynamicDuration === false) body.enable_dynamic_duration = false;
    if (opts.disableMusic) body.disable_music_track = true;
    if (opts.enhanceSpeech) body.enable_speech_enhancement = true;
    if (start !== undefined) body.start_time = start;
    if (end !== undefined) body.end_time = end;
    if (opts.brandGlossary) body.brand_glossary_id = opts.brandGlossary;
    if (opts.title) body.title = opts.title;
    if (opts.folder) body.folder_id = opts.folder;
    if (callbackUrl) body.callback_url = callbackUrl;
    if (opts.callbackId) body.callback_id = opts.callbackId;

    logger.info(`Submitting translation into ${languages.length} language(s)...`);
    const created = await client.createVideoTranslation(body);
    await completeJobs(client, "translation", created.video_translation_ids, opts, logger);
  });
}
