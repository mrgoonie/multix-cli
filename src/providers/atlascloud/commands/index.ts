/**
 * Registers the `atlas` command group (alias `atlascloud`).
 */

import type { Command } from "commander";
import { registerAtlasAudioCommand } from "./audio.js";
import { registerAtlasImageCommands } from "./image.js";
import { registerAtlasRunCommand } from "./run.js";
import { registerAtlasStatusCommand } from "./status.js";
import { registerAtlas3dCommand } from "./three-d.js";
import { registerAtlasUploadCommand } from "./upload.js";
import { registerAtlasVideoCommands } from "./video.js";

export function registerAtlasCloudCommands(program: Command): void {
  const atlas = program
    .command("atlas")
    .alias("atlascloud")
    .description(
      "Atlas Cloud: image, image-to-image, video, image-to-video, audio (TTS/STT/music), 3D, generic model runner, async status",
    );

  registerAtlasImageCommands(atlas);
  registerAtlasVideoCommands(atlas);
  registerAtlasAudioCommand(atlas);
  registerAtlas3dCommand(atlas);
  registerAtlasRunCommand(atlas);
  registerAtlasStatusCommand(atlas);
  registerAtlasUploadCommand(atlas);
}
