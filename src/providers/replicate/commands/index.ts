/**
 * Registers the `replicate` command group (direct Replicate API).
 * Independent of `multix cloudflare generate-video`, which reaches Replicate
 * through Cloudflare AI Gateway.
 */

import type { Command } from "commander";
import { registerReplicateCancelCommand } from "./cancel.js";
import { registerReplicateImageCommand } from "./image.js";
import { registerReplicateRunCommand } from "./run.js";
import { registerReplicateStatusCommand } from "./status.js";
import { registerReplicateVideoCommand } from "./video.js";

export function registerReplicateCommands(program: Command): void {
  const replicate = program
    .command("replicate")
    .description("Replicate: generic model runner, image, video, prediction status and cancel");

  registerReplicateRunCommand(replicate);
  registerReplicateImageCommand(replicate);
  registerReplicateVideoCommand(replicate);
  registerReplicateStatusCommand(replicate);
  registerReplicateCancelCommand(replicate);
}
