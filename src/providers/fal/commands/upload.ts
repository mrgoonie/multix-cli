/**
 * multix fal upload <file> — upload a local file to fal storage and print the
 * hosted URL as JSON on stdout (logs go to stderr), ready for any fal model
 * input such as `video_url` or `image_url`.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { inspectLocalFile, uploadLocalFile } from "../node-input-files.js";
import { parseExpiresIn } from "../storage.js";

export function registerFalUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local file to fal storage and print its URL as JSON")
    .option("--content-type <mime>", "MIME type to store (default: from the extension)")
    .option(
      "--expires-in <ttl>",
      "Ask fal to delete the upload after 1h, 1d, 7d, 30d, 1y or N seconds (default: fal's retention)",
    )
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        file: string,
        opts: { contentType?: string; expiresIn?: string; verbose?: boolean },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
        const expiresInSeconds =
          opts.expiresIn !== undefined ? parseExpiresIn(opts.expiresIn) : undefined;
        const local = inspectLocalFile(file, opts.contentType);
        const uploaded = await uploadLocalFile(local, { logger, expiresInSeconds });
        console.log(
          JSON.stringify(
            {
              ...uploaded,
              ...(expiresInSeconds !== undefined ? { expires_in_s: expiresInSeconds } : {}),
            },
            null,
            2,
          ),
        );
      },
    );
}
