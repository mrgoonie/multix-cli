/**
 * multix gemini video-status <interactionId> — inspect or resume a Gemini Omni
 * video without creating a new one. Prints a JSON summary (no media bytes or
 * file URIs); --wait polls to a terminal status; --download saves the video.
 * stdout carries only the result (that JSON, or the saved path): progress and
 * resume hints go to stderr, so `multix gemini video-status <id> | jq` parses.
 * Failed, cancelled or incomplete interactions exit non-zero.
 *
 * multix gemini video-cancel <interactionId> — cancel a running interaction.
 * It reads the interaction first: cancelling a completed one would mark it
 * cancelled, so a finished interaction is left as is.
 */

import path from "node:path";
import type { Command } from "commander";
import { ProviderError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { cancelInteraction } from "../client.js";
import {
  copyToOutput,
  findInteractionKey,
  resumeCommand,
  saveOmniVideo,
  waitForInteraction,
} from "../omni-flow.js";
import {
  type Interaction,
  interactionFailureMessage,
  isTerminalInteraction,
  summarizeInteraction,
} from "../omni.js";
import { parseWaitTimeout } from "./video-shared.js";

interface StatusOpts {
  wait?: boolean;
  download?: boolean;
  output?: string;
  waitTimeout?: string;
  verbose?: boolean;
}

export function registerGeminiVideoStatusCommands(parent: Command): void {
  parent
    .command("video-status <interactionId>")
    .description("Get a Gemini Omni video interaction's status; --wait/--download to resume it")
    .option("--wait", "Poll until the interaction reaches a terminal status")
    .option("--download", "Save the video once completed")
    .option("--output <path>", "Copy the saved video to this path")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (interactionId: string, opts: StatusOpts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const waitTimeoutMs = parseWaitTimeout(opts.waitTimeout);
      const found = await findInteractionKey(interactionId, logger);
      let interaction: Interaction = found.interaction;
      const id = String(interaction.id ?? interactionId);

      if (opts.wait && !isTerminalInteraction(interaction.status)) {
        interaction = await waitForInteraction(id, found.apiKey, waitTimeoutMs, logger);
      }

      if (interaction.status === "completed" && opts.download) {
        const dest = path.join(getOutputDir(), `gemini_omni_${outputStamp()}.mp4`);
        await saveOmniVideo(interaction, found.apiKey, dest, logger);
        logger.success(`Saved video: ${dest}`);
        copyToOutput(dest, opts.output, logger);
        console.log(dest);
        return;
      }

      console.log(JSON.stringify(summarizeInteraction(interaction), null, 2));
      if (!isTerminalInteraction(interaction.status)) {
        logger.info(`Still running. Resume with: ${resumeCommand(id)}`);
      } else if (interaction.status !== "completed") {
        throw new ProviderError(interactionFailureMessage(interaction), "gemini");
      }
    });

  parent
    .command("video-cancel <interactionId>")
    .description("Cancel a running Gemini Omni video interaction (finished ones are left as is)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (interactionId: string, opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      const found = await findInteractionKey(interactionId, logger);
      const id = String(found.interaction.id ?? interactionId);
      if (isTerminalInteraction(found.interaction.status)) {
        logger.info(`Interaction ${id} is already ${found.interaction.status}; nothing to cancel`);
        console.log(JSON.stringify(summarizeInteraction(found.interaction), null, 2));
        return;
      }
      const resp = await cancelInteraction(id, { apiKey: found.apiKey });
      console.log(JSON.stringify(summarizeInteraction(resp), null, 2));
      logger.success(`Cancel requested for ${id}`);
    });
}
