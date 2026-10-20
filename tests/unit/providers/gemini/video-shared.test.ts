import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import type { Logger } from "../../../../src/core/logger.js";
import {
  addOmniFlowOptions,
  addVideoFormatOptions,
  omniFormat,
  parseWaitTimeout,
  resolveVideoModel,
  veoFormat,
} from "../../../../src/providers/gemini/commands/video-shared.js";
import {
  GEMINI_OMNI_MODEL_DEFAULT,
  VEO_PREVIEW_SHUTDOWN_DATE,
} from "../../../../src/providers/gemini/models.js";
import { OMNI_DEFAULT_WAIT_MS } from "../../../../src/providers/gemini/omni-flow.js";

const MODEL = "gemini-omni-1.1-flash";

function makeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = {
    info() {},
    success() {},
    warn,
    error() {},
    debug() {},
    header() {},
  };
  return { logger, warn };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // The default video model can be overridden from the environment; pin it for these tests.
  for (const k of ["VIDEO_GEN_MODEL"]) {
    savedEnv[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
    else Reflect.deleteProperty(process.env, k);
  }
});

describe("resolveVideoModel", () => {
  it("defaults to the Omni model when no model is given", () => {
    expect(resolveVideoModel(undefined)).toEqual({
      model: GEMINI_OMNI_MODEL_DEFAULT,
      kind: "omni",
    });
  });

  it("routes gemini-omni models to the Omni flow, stripping a models/ prefix", () => {
    expect(resolveVideoModel(MODEL)).toEqual({ model: MODEL, kind: "omni" });
    expect(resolveVideoModel(`models/${MODEL}`)).toEqual({ model: MODEL, kind: "omni" });
  });

  it("routes veo models to the legacy Veo flow", () => {
    expect(resolveVideoModel("veo-3.1-generate-preview").kind).toBe("veo");
    // The Veo client strips the models/ prefix itself, so the id may keep it.
    expect(resolveVideoModel("models/veo-3.0-generate-001").kind).toBe("veo");
  });

  it("rejects any other model instead of re-routing it", () => {
    for (const model of ["gemini-2.5-flash", "imagen-4.0-generate-001", "", "omni-1"]) {
      expect(() => resolveVideoModel(model), JSON.stringify(model)).toThrow(ValidationError);
    }
    expect(() => resolveVideoModel("gemini-2.5-flash")).toThrow(/Unsupported Gemini video model/);
  });
});

describe("omniFormat", () => {
  it("fills the documented defaults when defaults are on", () => {
    expect(omniFormat({})).toEqual({
      aspectRatio: "16:9",
      resolution: "720p",
      durationSeconds: undefined,
    });
  });

  it("leaves unset options unset for a follow-up, so the source format is kept", () => {
    const format = omniFormat({}, false);
    expect(format.aspectRatio).toBeUndefined();
    expect(format.resolution).toBeUndefined();
    expect(format.durationSeconds).toBeUndefined();
  });

  it("lower-cases the resolution and parses the duration", () => {
    expect(omniFormat({ resolution: "4K", aspectRatio: "9:16", duration: "5s" })).toEqual({
      aspectRatio: "9:16",
      resolution: "4k",
      durationSeconds: 5,
    });
  });

  it("validates the values before anything is sent", () => {
    expect(() => omniFormat({ duration: "11" })).toThrow(ValidationError);
    expect(() => omniFormat({ aspectRatio: "4:3" })).toThrow(ValidationError);
    expect(() => omniFormat({ resolution: "1440p" })).toThrow(ValidationError);
  });
});

describe("veoFormat", () => {
  it("uses the Veo defaults when no flags are given", () => {
    const { logger } = makeLogger();
    expect(veoFormat({}, "veo-3.1-generate", logger)).toEqual({
      resolution: "1080p",
      aspectRatio: "16:9",
    });
  });

  it("accepts the Veo resolutions and aspect ratios", () => {
    const { logger } = makeLogger();
    expect(
      veoFormat({ resolution: "720p", aspectRatio: "9:16" }, "veo-3.1-generate", logger),
    ).toEqual({
      resolution: "720p",
      aspectRatio: "9:16",
    });
  });

  it("rejects the Omni-only flags instead of ignoring them", () => {
    const { logger } = makeLogger();
    const veo = "veo-3.1-generate";
    expect(() => veoFormat({ duration: "5" }, veo, logger)).toThrow(
      /--duration is supported for Gemini Omni/,
    );
    expect(() => veoFormat({ store: false }, veo, logger)).toThrow(
      /--no-store is supported for Gemini Omni/,
    );
    expect(() => veoFormat({ wait: false }, veo, logger)).toThrow(
      /--no-wait is supported for Gemini Omni/,
    );
  });

  it("rejects resolutions and aspect ratios that only Omni supports", () => {
    const { logger } = makeLogger();
    expect(() => veoFormat({ resolution: "4k" }, "veo-3.1-generate", logger)).toThrow(
      /Veo supports --resolution/,
    );
    expect(() => veoFormat({ aspectRatio: "4:3" }, "veo-3.1-generate", logger)).toThrow(
      /Veo supports --aspect-ratio/,
    );
  });

  it("warns that a -preview Veo model is shutting down", () => {
    const { logger, warn } = makeLogger();
    veoFormat({}, "veo-3.1-generate-preview", logger);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(VEO_PREVIEW_SHUTDOWN_DATE));
  });
});

describe("parseWaitTimeout", () => {
  it("defaults to the Omni wait when omitted", () => {
    expect(parseWaitTimeout(undefined)).toBe(OMNI_DEFAULT_WAIT_MS);
    expect(OMNI_DEFAULT_WAIT_MS).toBe(900_000);
  });

  it("accepts whole milliseconds of at least 1000", () => {
    expect(parseWaitTimeout("5000")).toBe(5000);
    expect(parseWaitTimeout("1000")).toBe(1000);
  });

  it("rejects values below one second or not whole numbers", () => {
    for (const bad of ["999", "1.5", "abc", "-1", ""]) {
      expect(() => parseWaitTimeout(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });
});

describe("command option wiring", () => {
  it("gives generate-style commands a default aspect ratio and a --duration flag", () => {
    const cmd = addVideoFormatOptions(new Command("generate-video"), { duration: true });
    const aspect = cmd.options.find((o) => o.long === "--aspect-ratio");
    expect(aspect?.defaultValue).toBe("16:9");
    expect(cmd.options.some((o) => o.long === "--duration")).toBe(true);
  });

  it("gives follow-up commands no format defaults, so the source format is kept", () => {
    const cmd = addVideoFormatOptions(new Command("edit-video"), {
      duration: false,
      followUp: true,
    });
    expect(cmd.options.find((o) => o.long === "--aspect-ratio")?.defaultValue).toBeUndefined();
    expect(cmd.options.find((o) => o.long === "--resolution")?.defaultValue).toBeUndefined();
    expect(cmd.options.some((o) => o.long === "--duration")).toBe(false);
  });

  it("adds --no-store, --no-wait and --wait-timeout to Omni commands", () => {
    const cmd = addOmniFlowOptions(new Command("generate-video"));
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--no-store", "--no-wait", "--wait-timeout"]));
    expect(cmd.options.find((o) => o.long === "--wait-timeout")?.defaultValue).toBe(
      String(OMNI_DEFAULT_WAIT_MS),
    );
  });
});
