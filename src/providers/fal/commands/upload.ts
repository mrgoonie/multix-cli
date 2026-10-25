/**
 * multix fal upload <file> — upload a local media file to fal storage and
 * print `{ url, mime_type, size_bytes, file_name }` as JSON, for use in
 * `fal run --input` payloads (or use `fal run --file field=path` directly).
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { requireFalKey } from "../client.js";
import { FAL_UPLOAD_NOTICE, inspectLocalMedia, uploadLocalFile } from "../local-files.js";

export function registerFalUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local media file to fal storage and print its URL as JSON")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      // stdout carries only the JSON so `jq -r .url` works; progress goes to stderr.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const apiKey = requireFalKey();
      await inspectLocalMedia(file);
      logger.info(FAL_UPLOAD_NOTICE);
      const uploaded = await uploadLocalFile(file, apiKey, logger);
      console.log(JSON.stringify(uploaded, null, 2));
    });
}
