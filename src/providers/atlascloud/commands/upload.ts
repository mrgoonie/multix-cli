/**
 * multix atlas upload <file> — upload a local file via POST /model/uploadMedia
 * and print the temporary URL, for use in `atlas run --input` payloads.
 */

import type { Command } from "commander";
import { createAtlasClientFromEnv, createAtlasLogger, resolveMediaRef } from "./env.js";

export function registerAtlasUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local file to Atlas Cloud and print its temporary URL")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      // stdout carries only the URL so `url=$(multix atlas upload f.png)` works.
      const logger = createAtlasLogger({ verbose: opts.verbose, stdoutReserved: true });
      if (/^(https?|data):/i.test(file.trim())) {
        logger.warn("Input is already a URL; nothing to upload.");
        console.log(file.trim());
        return;
      }
      const client = createAtlasClientFromEnv();
      console.log(await resolveMediaRef(client, file, logger));
    });
}
