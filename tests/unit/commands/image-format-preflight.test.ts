/**
 * An invalid --image-format or MULTIX_IMAGE_FORMAT must stop every image
 * command before its action runs, so no paid request is sent. Every command
 * offering the flag is exercised through the real registry.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../../../src/commands/index.js";

function buildProgram(): Command {
  const program = new Command().name("multix").enablePositionalOptions();
  registerCommands(program);
  return program;
}

interface Target {
  path: string[];
  args: string[];
}

/** Every leaf command with --image-format, with placeholder required arguments. */
function imageFormatCommands(cmd: Command, path: string[] = []): Target[] {
  const out: Target[] = [];
  for (const sub of cmd.commands) {
    const subPath = [...path, sub.name()];
    if (sub.options.some((o) => o.long === "--image-format")) {
      const args = sub.registeredArguments.filter((a) => a.required).map(() => "placeholder");
      for (const o of sub.options) {
        if (o.mandatory && o.long) args.push(o.long, "placeholder");
      }
      out.push({ path: subPath, args });
    }
    out.push(...imageFormatCommands(sub, subPath));
  }
  return out;
}

const targets = imageFormatCommands(buildProgram());
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("fetch must not be called");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("MULTIX_IMAGE_FORMAT", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("image format preflight", () => {
  it("finds every image command that offers --image-format", () => {
    const names = targets.map((t) => t.path.join(" "));
    expect(names).toEqual(
      expect.arrayContaining([
        "gemini generate",
        "openai image-to-image",
        "replicate image",
        "runway image",
        "sume image",
      ]),
    );
    expect(targets).toHaveLength(23);
  });

  it.each(targets.map((t) => [t.path.join(" "), t] as const))(
    "%s rejects --image-format webpp before any request",
    async (_name, target) => {
      const argv = ["node", "multix", ...target.path, ...target.args, "--image-format", "webpp"];
      await expect(buildProgram().parseAsync(argv)).rejects.toThrow(
        /Invalid --image-format: webpp/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects a bad MULTIX_IMAGE_FORMAT before any request", async () => {
    vi.stubEnv("MULTIX_IMAGE_FORMAT", "png");
    const target = targets.find((t) => t.path.join(" ") === "runway image");
    expect(target).toBeDefined();
    const argv = ["node", "multix", ...(target as Target).path, "a cat"];
    await expect(buildProgram().parseAsync(argv)).rejects.toThrow(/Invalid --image-format: png/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets --no-webp override a bad env value, as before", async () => {
    vi.stubEnv("MULTIX_IMAGE_FORMAT", "png");
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const argv = ["node", "multix", "runway", "image", "a cat", "--no-webp"];
    // Passes the preflight and stops later on the missing key, still before any request.
    await expect(buildProgram().parseAsync(argv)).rejects.toThrow(/RUNWAYML_API_SECRET/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["--image-format original", ["--image-format", "original"], ""],
    ["--image-format WEBP", ["--image-format", "WEBP"], ""],
    ["an empty env value", [], ""],
    ["MULTIX_IMAGE_FORMAT=original", [], "original"],
  ])("accepts %s and goes on to the action", async (_name, flags, env) => {
    vi.stubEnv("MULTIX_IMAGE_FORMAT", env);
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const argv = ["node", "multix", "runway", "image", "a cat", ...flags];
    await expect(buildProgram().parseAsync(argv)).rejects.toThrow(/RUNWAYML_API_SECRET/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a bad env value on commands without --image-format", async () => {
    vi.stubEnv("MULTIX_IMAGE_FORMAT", "png");
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const argv = ["node", "multix", "runway", "video", "a cat"];
    await expect(buildProgram().parseAsync(argv)).rejects.toThrow(/RUNWAYML_API_SECRET/);
  });
});
