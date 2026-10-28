/**
 * multix topview upload <file> --api legacy|platform — upload a reference file.
 * The two APIs keep separate storage, so the API is always named explicitly:
 * - legacy: prints the file id; pass it to task flags as asset:<fileId>;
 * - platform: prints the asset as JSON; its download_url (temporary, signed)
 *   goes into the model's documented image or reference field.
 * The signed URL is the command's result on stdout and is never logged.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import {
  createLegacyClientFromEnv,
  createPlatformClientFromEnv,
  createTopviewLogger,
  resolveLegacyFile,
  uploadPlatformAsset,
} from "./env.js";
import { oneOf } from "./json-input.js";

const APIS = ["legacy", "platform"] as const;

export function registerUploadCommand(parent: Command): void {
  parent
    .command("upload <file>")
    .description("Upload a local image/video/audio to the legacy API or the API Platform")
    .requiredOption("--api <api>", "Which TopView API to upload to: legacy or platform")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { api: string; verbose?: boolean }) => {
      const api = oneOf(opts.api, APIS, "--api");
      const logger = createTopviewLogger({ verbose: opts.verbose, stdoutReserved: true });
      if (api === "legacy") {
        const fileId = await resolveLegacyFile(createLegacyClientFromEnv(), file, logger);
        run.data = { api, file_id: fileId, ref: `asset:${fileId}` };
        console.log(`asset:${fileId}`);
        return;
      }
      const asset = await uploadPlatformAsset(createPlatformClientFromEnv(), file, logger);
      run.data = { api, ...asset };
      console.log(JSON.stringify(asset, null, 2));
    });
}
