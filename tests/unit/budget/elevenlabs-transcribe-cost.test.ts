/**
 * ElevenLabs bills Scribe v3, v2 and v2 Medical at USD 0.20 per hour of input
 * audio, per audio minute. The estimate prices the measured length of the
 * local --input file; the high end adds a margin and rounds up to a whole
 * minute, so it is a proven cap. The deprecated scribe_v1 has no published
 * price and stays unknown. Pure functions, no network.
 */

import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-11-12T12:00:00Z");

describe("elevenlabs transcribe cost", () => {
  it("prices the measured input length per second of audio", () => {
    expect(pricedCommands()).toContain("elevenlabs transcribe");
    const e = estimateCommand(
      "elevenlabs transcribe",
      { input: "clip.mp3", model: "scribe_v2", language: "vi" },
      { audioSeconds: 27, at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      provider: "elevenlabs",
      model: "scribe_v2",
      upper_bound: "proven",
      units: { input_audio_seconds: { low: 27, expected: 27, high: 60 } },
      rate: { id: "elevenlabs/scribe@api", source: "https://elevenlabs.io/pricing/api" },
    });
    expect(e.expected_usd).toBeCloseTo((0.2 / 3600) * 27, 5);
    expect(e.high_usd).toBeCloseTo((0.2 / 3600) * 60, 5);
  });

  it("prices every current batch Scribe model at one rate", () => {
    for (const model of ["scribe_v3", "scribe_v2_medical", " scribe_v2 "]) {
      const e = estimateCommand(
        "elevenlabs transcribe",
        { "--input": "a.wav", "--model": model },
        { audioSeconds: 3600, at: AT },
      );
      expect(e.status).toBe("estimated");
      expect(e.model).toBe(model.trim());
      expect(e.expected_usd).toBeCloseTo(0.2, 5);
    }
  });

  it("leaves the deprecated scribe_v1 models unpriced and names the replacements", () => {
    for (const model of ["scribe_v1", "scribe_v1_experimental"]) {
      const e = estimateCommand(
        "elevenlabs transcribe",
        { input: "a.wav", model },
        { audioSeconds: 10, at: AT },
      );
      expect(e).toMatchObject({ status: "unknown", reason: "no_price", high_usd: null });
      expect(e.detail).toContain(`${model} is deprecated`);
      expect(e.detail).toContain("scribe_v2");
    }
  });

  it("is unknown without a local file whose length is known", () => {
    const noInput = estimateCommand("elevenlabs transcribe", { model: "scribe_v2" }, { at: AT });
    expect(noInput).toMatchObject({ status: "unknown", reason: "missing_input" });
    expect(noInput.detail).toContain("--input");
    const noLength = estimateCommand(
      "elevenlabs transcribe",
      { input: "https://example.com/a.mp3", model: "scribe_v2" },
      { at: AT },
    );
    expect(noLength).toMatchObject({ status: "unknown", reason: "missing_input" });
  });

  it("does not price an unknown model or another ElevenLabs task's model", () => {
    for (const model of ["scribe_v9", "eleven_multilingual_v2", "music_v1"]) {
      const e = estimateCommand(
        "elevenlabs transcribe",
        { input: "a.wav", model },
        { audioSeconds: 10, at: AT },
      );
      expect(e.status).toBe("unknown");
    }
  });

  it("never prices a transcription with a speech model's per-character rate", () => {
    // Empty text would otherwise price a speech model at $0.
    const e = estimateCommand(
      "openrouter transcribe",
      { input: "a.wav", model: "elevenlabs/eleven-v4" },
      { audioSeconds: 10, at: AT },
    );
    expect(e).toMatchObject({ status: "unknown", reason: "no_price", high_usd: null });
  });

  it("--max-cost refuses below the ceiling and passes above it under the strict policy", () => {
    const e = estimateCommand(
      "elevenlabs transcribe",
      { input: "clip.mp3", model: "scribe_v3" },
      { audioSeconds: 27, at: AT },
    );
    expect(() => checkBudget(e, 0.001, "strict")).toThrow(BudgetError);
    try {
      checkBudget(e, 0.001, "strict");
    } catch (error) {
      expect((error as BudgetError).code).toBe("BUDGET_EXCEEDED");
    }
    expect(() => checkBudget(e, 0.01, "strict")).not.toThrow();
  });
});
