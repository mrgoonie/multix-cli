/**
 * Registers the `byteplus` command group.
 */

import type { Command } from "commander";
import { registerBytePlusGenerateCommand } from "./generate.js";
import { registerBytePlusImageToVideoCommand } from "./image-to-video.js";
import { registerBytePlusReferenceToVideoCommand } from "./reference-to-video.js";
import { registerBytePlusStatusCommand } from "./status.js";
import { registerBytePlusVideoCommand } from "./video.js";

export function registerBytePlusCommands(program: Command): void {
  const byteplus = program
    .command("byteplus")
    .description("BytePlus ModelArk: Seedream image generation, Seedance video generation");

  registerBytePlusGenerateCommand(byteplus);
  registerBytePlusVideoCommand(byteplus);
  registerBytePlusImageToVideoCommand(byteplus);
  registerBytePlusReferenceToVideoCommand(byteplus);
  registerBytePlusStatusCommand(byteplus);
}
