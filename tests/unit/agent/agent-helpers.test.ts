import { describe, expect, it } from "vitest";
import { shellQuote } from "../../../src/agent/agent-runtime.js";
import { modelFromRequest, safeUrl } from "../../../src/agent/fetch-telemetry.js";
import {
  nextForError,
  stdoutPayload,
  suggestedCommands,
} from "../../../src/agent/result-envelope.js";
import { type RunState, run, summarizeUsage } from "../../../src/agent/run-state.js";
import { modelsFromDescription } from "../../../src/commands/agent/models-command.js";
import { classifyMessage } from "../../../src/core/error-classify.js";

describe("result envelope helpers", () => {
  it("returns JSON stdout as data and text otherwise", () => {
    expect(stdoutPayload(['{"a":1}\n'])).toEqual({ data: { a: 1 } });
    expect(stdoutPayload(["\x1b[32mSaved\x1b[0m out.png\n"])).toEqual({ text: "Saved out.png" });
    expect(stdoutPayload([])).toEqual({});
  });

  it("collects printed follow-up commands, not the current one", () => {
    const found = suggestedCommands(
      ["Job queued. Check: multix runway status abc123\nmultix fal image\n"],
      "fal image",
    );
    expect(found).toEqual(["multix runway status abc123"]);
  });

  it("ignores prose that only starts with multix", () => {
    const known = new Set(["check", "runway"]);
    expect(suggestedCommands(["✓ multix is ready to use\n"], "check", known)).toEqual([]);
    expect(suggestedCommands(["Run: multix runway status t1\n"], "runway video", known)).toEqual([
      "multix runway status t1",
    ]);
  });

  it("shell-quotes arguments that need it", () => {
    expect(["fal", "image", "a red fox, snow", "it's"].map(shellQuote).join(" ")).toBe(
      "fal image 'a red fox, snow' 'it'\\''s'",
    );
  });

  it("suggests next steps by error class", () => {
    expect(nextForError(classifyMessage("FAL_KEY is not set"), "fal image", "fal", "h_1")).toEqual([
      "multix check",
      "multix models --task image --ready",
    ]);
    expect(nextForError(classifyMessage("HTTP 503 down"), "fal image", "fal", "h_1")).toEqual([
      "multix rerun h_1",
    ]);
    expect(nextForError(classifyMessage("error: unknown option '-x'"), "", "", undefined)).toEqual([
      "multix --help",
    ]);
  });
});

describe("telemetry helpers", () => {
  it("drops query strings from URLs", () => {
    expect(safeUrl("https://x.example/a/b?key=secret#f")).toBe("https://x.example/a/b");
  });

  it("finds the model in a Gemini path or a JSON body", () => {
    expect(modelFromRequest("/v1beta/models/gemini-2.5-flash:generateContent", undefined)).toBe(
      "gemini-2.5-flash",
    );
    expect(modelFromRequest("/v1/images", JSON.stringify({ model: "gpt-image-2" }))).toBe(
      "gpt-image-2",
    );
    expect(modelFromRequest("/v1/images", "not json")).toBeUndefined();
  });

  it("sums create usage and keeps the last poll value", () => {
    const state = {
      ...run,
      postUsage: [
        { tokens: { input: 1 }, cost_usd: 0.01, metrics: { a: 1 }, ids: [] },
        { tokens: { input: 2 }, cost_usd: 0.02, metrics: { a: 2 }, ids: [] },
      ],
      getUsage: new Map([
        ["host/status/:id", { tokens: {}, credits: 7, metrics: { b: 9 }, ids: [] }],
      ]),
    } as RunState;
    expect(summarizeUsage(state)).toEqual({
      tokens: { input: 3 },
      cost_usd: 0.03,
      credits: 7,
      metrics: { a: 3, b: 9 },
    });
  });

  it("keeps where each provider reported its credits", () => {
    const src = { credits: "api.elevenlabs.io header.character-cost" };
    const state = {
      ...run,
      postUsage: [
        { tokens: {}, credits: 3, metrics: {}, ids: [], sources: src },
        { tokens: {}, credits: 2, metrics: {}, ids: [], sources: src },
      ],
      getUsage: new Map(),
    } as RunState;
    expect(summarizeUsage(state)).toEqual({
      credits: 5,
      sources: { credits: ["api.elevenlabs.io header.character-cost"] },
    });
  });
});

describe("modelsFromDescription", () => {
  it("reads defaults, choices and examples, ignoring prose words", () => {
    expect(
      modelsFromDescription("Video model: gemini-omni-1.1-flash (default) or veo-3.1"),
    ).toEqual({
      def: "gemini-omni-1.1-flash",
      models: ["gemini-omni-1.1-flash", "veo-3.1"],
    });
    expect(modelsFromDescription("Model id (e.g. MOTION2, VEO3, kling-2.6)").models).toEqual([
      "MOTION2",
      "VEO3",
      "kling-2.6",
    ]);
    expect(modelsFromDescription("Model (speech-2.8-hd|speech-2.6-turbo)").models).toEqual([
      "speech-2.8-hd",
      "speech-2.6-turbo",
    ]);
    expect(modelsFromDescription("Model id; default depends on the endpoint").def).toBeUndefined();
  });
});
