/**
 * multix sume upload <file> — upload a local image, video or audio file to
 * Sume's media storage (free) and print its public https URL, usable in any
 * `--image`/`--video`/`--audio` option or `--input` URL field. The signed
 * upload URL is never printed.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { createSumeClient } from "../node-client.js";
import { ALL_MEDIA_KINDS, uploadLocalFile } from "../node-inputs.js";

export function registerSumeUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local media file to Sume and print its public URL")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const client = createSumeClient();
      const url = await uploadLocalFile(file, "<file>", ALL_MEDIA_KINDS, client, logger);
      console.log(url);
    });
}
