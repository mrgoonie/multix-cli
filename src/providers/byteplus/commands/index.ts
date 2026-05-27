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
      "BytePlus ModelArk: image (Seedream 4.0), video (Seedance 2.0 text/image/reference-to-video), and 3D (Hyper3D / Hitem3d)",
    );

  registerBytePlusGenerateCommand(byteplus);
  registerBytePlusImageToImageCommand(byteplus);
  registerBytePlusVideoCommand(byteplus);
  registerBytePlusImageToVideoCommand(byteplus);
  registerBytePlusReferenceToVideoCommand(byteplus);
  registerBytePlusGenerate3DCommand(byteplus);
  registerBytePlusStatusCommand(byteplus);
}
