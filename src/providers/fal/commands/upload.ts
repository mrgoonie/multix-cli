/**
 * multix fal upload <file> — upload a local file to fal storage and print
 * `{ url, file_name, mime_type, size_bytes }` as JSON on stdout, for use in
 * any model's input (e.g. `video_url`). Progress and notices go to stderr.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { requireFalKey } from "../client.js";
import { FAL_UPLOAD_NOTICE, checkLocalFile, uploadLocalFile } from "../local-files.js";
import { FAL_EXPIRY_PRESETS, parseFalExpiry } from "../storage.js";

export function registerFalUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local file to fal storage and print its URL as JSON")
    .option(
      "--expires-in <ttl>",
      `Ask fal to delete the upload after ${FAL_EXPIRY_PRESETS.filter((p) => p !== "never").join("/")} or N seconds`,
    )
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { expiresIn?: string; verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const expiresInSeconds = opts.expiresIn ? parseFalExpiry(opts.expiresIn) : undefined;
      const apiKey = requireFalKey();
      checkLocalFile(file);
      logger.warn(FAL_UPLOAD_NOTICE);
      const uploaded = await uploadLocalFile(file, { apiKey, expiresInSeconds, logger });
      logger.success(`Uploaded ${uploaded.file_name}`);
      console.log(JSON.stringify(uploaded, null, 2));
    });
}
