/**
 * multix elevenlabs dub — Dubbing (truly async).
 * POST /v1/dubbing               -> { dubbing_id, expected_duration_sec }
 * GET  /v1/dubbing/{id}          -> { status: "dubbing"|"dubbed"|"failed", target_languages: [...] }
 * GET  /v1/dubbing/{id}/audio/{lang} -> binary mp3
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { downloadFile } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import {
  apiGet,
  apiPostMultipart,
  pollUntil,
  readFileAsBlob,
  requireElevenLabsKey,
} from "../client.js";
import { ELEVENLABS_BASE_URL } from "../models.js";

interface DubStartResp {
  dubbing_id: string;
  expected_duration_sec?: number;
}

interface DubStatusResp {
  dubbing_id?: string;
  status?: string;
  target_languages?: string[];
  error_message?: string;
}

export function registerDubCommand(parent: Command): void {
  parent
    .command("dub")
    .description("Dub a video/audio file into target languages (async)")
    .option("--input <path>", "Source media file (use --input or --source-url)")
    .option("--source-url <url>", "Public URL of source media")
    .requiredOption("--target-lang <code>", "Target language ISO code (e.g. es, fr, de)")
    .option("--source-lang <code>", "Source language (auto if omitted)")
    .option("--num-speakers <n>", "Speaker count (auto if omitted)")
    .option("--watermark", "Add ElevenLabs watermark", false)
    .option("--start-time <s>", "Start time in seconds")
    .option("--end-time <s>", "End time in seconds")
    .option("--highest-resolution", "Use highest resolution video", false)
    .option("--name <n>", "Project display name")
    .option("--async", "Return job id immediately, do not wait", false)
    .option("--wait", "Wait until status=dubbed (implied by --download)", false)
    .option("--download", "Download dubbed media when ready", false)
    .option("--poll-interval <s>", "Poll interval seconds", "10")
    .option("--wait-timeout <ms>", "Poll timeout", "1800000")
    .option("--output <path>", "Output path for downloaded dub")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();
      if (!opts.input && !opts.sourceUrl) {
        throw new ValidationError("Provide --input <path> or --source-url <url>");
      }

      const form = new FormData();
      if (opts.input) form.append("file", readFileAsBlob(opts.input));
      if (opts.sourceUrl) form.append("source_url", opts.sourceUrl);
      form.append("target_lang", opts.targetLang);
      if (opts.sourceLang) form.append("source_lang", opts.sourceLang);
      if (opts.numSpeakers) form.append("num_speakers", opts.numSpeakers);
      if (opts.watermark) form.append("watermark", "true");
      if (opts.startTime) form.append("start_time", opts.startTime);
      if (opts.endTime) form.append("end_time", opts.endTime);
      if (opts.highestResolution) form.append("highest_resolution", "true");
      if (opts.name) form.append("name", opts.name);

      logger.debug(`Submitting dub -> ${opts.targetLang}`);
      const start = await apiPostMultipart<DubStartResp>("dubbing", form, apiKey, {
        timeoutMs: 600_000,
      });
      console.log(
        `Dubbing job: ${start.dubbing_id} (expected ~${start.expected_duration_sec ?? "?"}s)`,
      );

      if (opts.async && !opts.wait && !opts.download) {
        console.log("Run `multix elevenlabs dub-status <id>` to check progress.");
        return;
      }

      const final = await pollUntil<DubStatusResp>(
        () => apiGet<DubStatusResp>(`dubbing/${start.dubbing_id}`, apiKey),
        (s) => s.status === "dubbed",
        (s) => s.status === "failed",
        {
          intervalMs: Number.parseInt(opts.pollInterval, 10) * 1000,
          timeoutMs: Number.parseInt(opts.waitTimeout, 10),
          logger,
          label: `dub ${start.dubbing_id}`,
        },
      );
      logger.success(`Dub complete: ${start.dubbing_id}`);

      if (opts.download) {
        const dest = opts.output
          ? path.resolve(opts.output)
          : path.join(getOutputDir(), `elevenlabs_dub_${start.dubbing_id}_${opts.targetLang}.mp4`);
        const url = `${ELEVENLABS_BASE_URL}/dubbing/${start.dubbing_id}/audio/${opts.targetLang}`;
        await downloadDub(url, apiKey, dest);
        logger.success(`Saved: ${dest}`);
        console.log(`\nDubbed file: ${dest}`);
      } else {
        console.log(`Languages ready: ${(final.target_languages ?? []).join(", ")}`);
      }
    });

  parent
    .command("dub-status <dubbingId>")
    .description("Check dubbing status / list available languages")
    .option("--download <lang>", "Download dubbed file for a language code")
    .option("--output <path>", "Output path")
    .action(async (dubbingId: string, opts) => {
      const apiKey = requireElevenLabsKey();
      const status = await apiGet<DubStatusResp>(`dubbing/${dubbingId}`, apiKey);
      console.log(JSON.stringify(status, null, 2));
      if (opts.download) {
        const dest = opts.output
          ? path.resolve(opts.output)
          : path.join(getOutputDir(), `elevenlabs_dub_${dubbingId}_${opts.download}.mp4`);
        const url = `${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}/audio/${opts.download}`;
        await downloadDub(url, apiKey, dest);
        console.log(`Saved: ${dest}`);
      }
    });
}

async function downloadDub(url: string, apiKey: string, dest: string): Promise<void> {
  // The shared downloadFile helper does not pass auth headers; do it inline.
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await globalThis.fetch(url, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download dub: HTTP ${res.status}`);
  }
  const arr = new Uint8Array(await res.arrayBuffer());
  fs.writeFileSync(dest, arr);
  // downloadFile import retained in case of future stream-based override
  void downloadFile;
}
