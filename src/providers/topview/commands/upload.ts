/**
 * `topview upload <file>` (Legacy API): upload a local file (or an https URL,
 * fetched by multix first) through the presigned-URL flow and print its
 * fileId as JSON, for flags such as --bg-removed-file-id or
 * --product-file-id. Uploads are not billed.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { LEGACY_UPLOAD_FORMATS, type UploadKind } from "../models.js";
import { createTopviewLegacyClient } from "../node-client.js";
import { prepareFileInput, uploadPreparedFile } from "../node-inputs.js";

const ALL_KINDS = Object.keys(LEGACY_UPLOAD_FORMATS) as UploadKind[];

export function registerTopviewUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description(
      "Legacy API: upload an image, audio or video file and print its fileId (not billed)",
    )
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      // stdout carries only the JSON result.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const prepared = prepareFileInput(file, "<file>", ALL_KINDS);
      const client = createTopviewLegacyClient();
      const fileId = await uploadPreparedFile(client, prepared, logger);
      logger.success(`Uploaded ${prepared.name}`);
      console.log(
        JSON.stringify(
          { fileId, name: prepared.name, ...(prepared.format ? { format: prepared.format } : {}) },
          null,
          2,
        ),
      );
    });
}
