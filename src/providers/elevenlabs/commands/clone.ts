/**
 * multix elevenlabs clone — Instant Voice Cloning (IVC).
 * Endpoint: POST /v1/voices/add (multipart with up to ~25 sample files).
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiPostMultipart, readFileAsBlob, requireElevenLabsKey } from "../client.js";

interface AddVoiceResp {
  voice_id: string;
  requires_verification?: boolean;
}

export function registerCloneCommand(parent: Command): void {
  parent
    .command("clone")
    .description("Instant voice cloning from local audio samples")
    .requiredOption("--name <n>", "Display name for the new voice")
    .option("--files <paths...>", "One or more audio sample files (1-3 minutes total)")
    .option("--audio <path>", "Single sample file (alias for --files)")
    .option("--description <d>", "Voice description")
    .option("--labels <kv>", 'JSON object of labels, e.g. \'{"accent":"american"}\'')
    .option("--remove-background-noise", "Server-side noise removal", false)
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      const files: string[] = opts.files ?? (opts.audio ? [opts.audio] : []);
      if (files.length === 0) {
        throw new ValidationError("Provide --files <p1> <p2>... or --audio <path>");
      }

      const form = new FormData();
      form.append("name", opts.name);
      if (opts.description) form.append("description", opts.description);
      if (opts.labels) {
        try {
          JSON.parse(opts.labels);
          form.append("labels", opts.labels);
        } catch {
          throw new ValidationError("--labels must be valid JSON");
        }
      }
      if (opts.removeBackgroundNoise) form.append("remove_background_noise", "true");
      for (const f of files) form.append("files", readFileAsBlob(f));

      logger.debug(`Cloning ${files.length} sample(s) as "${opts.name}"`);
      const data = await apiPostMultipart<AddVoiceResp>("voices/add", form, apiKey, {
        timeoutMs: 300_000,
      });
      console.log(`Created voice: ${data.voice_id}`);
      if (data.requires_verification) {
        console.warn("Voice requires verification before use (PVC pipeline).");
      }
    });
}
