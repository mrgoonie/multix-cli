/**
 * multix gemini video-status [interactionId] — look up a stored Gemini Omni
 * interaction, optionally wait for it and download its video. Used to recover
 * a run that timed out locally (`--background`, `--timeout`) without paying
 * for a second generation.
 *
 * Prints one JSON object on stdout (no video bytes, no URIs); logs go to stderr.
 */

import path from "node:path";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { assertInteractionId } from "../client.js";
import {
  type OmniSessionRecord,
  fetchOmniStatus,
  parseTimeoutSeconds,
  readSessionRecord,
  saveOmniVideo,
  writeSessionRecord,
} from "../omni-run.js";
import { assertOmniCompleted, extractOmniVideo, isOmniRunning } from "../omni.js";
import { copyToOutput } from "./generate-video.js";

interface VideoStatusOptions {
  session?: string;
  keyEnv?: string;
  wait?: boolean;
  download?: boolean;
  output?: string;
  timeout?: string;
  verbose?: boolean;
}

export function registerGeminiVideoStatusCommand(parent: Command): void {
  parent
    .command("video-status [interactionId]")
    .description("Check (and optionally download) a stored Gemini Omni video interaction")
    .option("--session <file>", "Session file (*.interaction.json) from an Omni command")
    .option("--key-env <name>", "Env var of the key that created it (default: the session's)")
    .option("--wait", "Poll until the interaction finishes")
    .option("--download", "Save the video once the interaction is completed")
    .option("--output <path>", "Copy the downloaded video to this path")
    .option("--timeout <seconds>", "Overall wait in seconds with --wait (default 900)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (interactionId: string | undefined, opts: VideoStatusOptions) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      if ((interactionId === undefined) === (opts.session === undefined)) {
        throw new ValidationError("Pass an interaction id or --session <file> (not both)");
      }
      const record: OmniSessionRecord | undefined = opts.session
        ? readSessionRecord(opts.session)
        : undefined;
      const id = assertInteractionId(record?.interaction_id ?? interactionId ?? "");
      const timeoutMs = parseTimeoutSeconds(opts.timeout);

      const { interaction, apiKey } = await fetchOmniStatus({
        interactionId: id,
        keyEnv: opts.keyEnv ?? record?.key_env,
        wait: opts.wait === true,
        timeoutMs,
        logger,
      });
      const video = extractOmniVideo(interaction);
      const summary: Record<string, unknown> = {
        interaction_id: interaction.id ?? id,
        status: interaction.status ?? "unknown",
        model: interaction.model,
        has_video: video !== undefined,
        ...(interaction.usage !== undefined ? { usage: interaction.usage } : {}),
      };

      if (opts.download) {
        if (isOmniRunning(interaction)) {
          throw new ProviderError(
            `Interaction ${id} is ${interaction.status}; retry with --wait --download`,
            "gemini",
          );
        }
        assertOmniCompleted(interaction);
        if (!video) throw new ProviderError(`Interaction ${id} has no video`, "gemini");
        // Always the output dir: a session file may live elsewhere (e.g. a remote job's inputs).
        const name = opts.session
          ? path.basename(opts.session).replace(/\.interaction\.json$|\.json$/, "")
          : `omni_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const base = path.join(getOutputDir(), `${name}.mp4`);
        await saveOmniVideo(video, base, apiKey, logger, timeoutMs);
        copyToOutput(base, opts.output, logger);
        summary.output_path = base;
        if (record && opts.session) {
          writeSessionRecord(opts.session, {
            ...record,
            status: interaction.status ?? record.status,
            output_path: path.resolve(base),
            updated_at: new Date().toISOString(),
            ...(interaction.usage !== undefined ? { usage: interaction.usage } : {}),
          });
        }
      }
      console.log(JSON.stringify(summary, null, 2));
    });
}
