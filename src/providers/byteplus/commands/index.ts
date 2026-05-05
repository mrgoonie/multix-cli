/**
 * Registers the `byteplus` command group.
 */

import type { Command } from "commander";
import { registerBytePlusGenerate3DCommand } from "./generate-3d.js";
import { registerBytePlusGenerateCommand } from "./generate.js";
import { registerBytePlusImageToImageCommand } from "./image-to-image.js";
import { registerBytePlusImageToVideoCommand } from "./image-to-video.js";
import { registerBytePlusReferenceToVideoCommand } from "./reference-to-video.js";
import { registerBytePlusStatusCommand } from "./status.js";
import { registerBytePlusVideoCommand } from "./video.js";

export function registerBytePlusCommands(program: Command): void {
  const byteplus = program
    .command("byteplus")
    .description(
      "BytePlus ModelArk: Seedream image, Seedance video, Hyper3D / Hitem3d 3D generation",
    );

  registerBytePlusGenerateCommand(byteplus);
  registerBytePlusImageToImageCommand(byteplus);
  registerBytePlusVideoCommand(byteplus);
  registerBytePlusImageToVideoCommand(byteplus);
  registerBytePlusReferenceToVideoCommand(byteplus);
  registerBytePlusGenerate3DCommand(byteplus);
  registerBytePlusStatusCommand(byteplus);
}
