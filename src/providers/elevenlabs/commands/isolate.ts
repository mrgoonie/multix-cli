/**
 * multix elevenlabs isolate — Voice Isolator (audio-isolation).
 * Endpoint: POST /v1/audio-isolation (multipart, sync, returns mp3 bytes).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { apiPostBinary, readFileAsBlob, requireElevenLabsKey, saveBytes } from "../client.js";

export function registerIsolateCommand(parent: Command): void {
  parent
    .command("isolate")
    .description("Voice isolator: strip background noise from audio")
    .requiredOption("--input <path>", "Source audio/video file")
    .option("--output <path>", "Copy isolated audio to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      const form = new FormData();
      form.append("audio", readFileAsBlob(opts.input));

      logger.debug(`Isolating ${opts.input}`);
      const bytes = await apiPostBinary("audio-isolation", form, apiKey, {
        timeoutMs: 600_000,
      });
      const dest = saveBytes({
        bytes,
        task: "isolate",
        ext: "mp3",
        outputCopy: opts.output,
        logger,
      });
      console.log(`\nIsolated audio: ${dest}`);
    });
}
