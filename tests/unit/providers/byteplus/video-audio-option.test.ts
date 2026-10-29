/**
 * The Seedance video commands leave --audio unset unless a flag is given, so
 * generate_audio is sent only on request (`--no-audio` declared first would
 * default it to true).
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBytePlusCommands } from "../../../../src/providers/byteplus/commands/index.js";

describe("byteplus video commands: --audio default", () => {
  const program = new Command();
  registerBytePlusCommands(program);
  const byteplus = program.commands.find((c) => c.name() === "byteplus");

  it.each(["video", "image-to-video", "reference-to-video"])("%s has no audio default", (name) => {
    const command = byteplus?.commands.find((c) => c.name() === name);
    expect(command).toBeDefined();
    expect(command?.getOptionValue("audio")).toBeUndefined();
  });
});
