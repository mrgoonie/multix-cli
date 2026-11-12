/**
 * ElevenLabs bills Sound Effects at USD 0.12 and Eleven Music at USD 0.15 per
 * minute of audio. The estimate prices the length the request asks for, or
 * the longest the model may pick when none is set (30 s of sound, 10 min of
 * music). The page publishes no rounding, so the high end is an estimate:
 * --max-cost enforces it under --cost-policy estimate only. Pure functions
 * plus one plan file in a temp dir, no network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { musicPlanLengthMs } from "../../../src/agent/cost-preflight.js";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-11-12T12:00:00Z");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-music-plan-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("elevenlabs sfx cost", () => {
  it("prices a set duration per second of sound", () => {
    expect(pricedCommands()).toEqual(
      expect.arrayContaining(["elevenlabs sfx", "elevenlabs music"]),
    );
    const e = estimateCommand(
      "elevenlabs sfx",
      { text: "bronze drum hit", durationSeconds: "3" },
      { at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      provider: "elevenlabs",
      model: "eleven_text_to_sound_v2",
      low_usd: 0.006,
      expected_usd: 0.006,
      high_usd: 0.006,
      upper_bound: "estimated",
      units: { output_audio_seconds: { low: 3, expected: 3, high: 3 } },
    });
    expect(e.rate).toMatchObject({
      id: "elevenlabs/sound-effects@api",
      source: "https://elevenlabs.io/pricing/api",
    });
  });

  it("prices an omitted duration at the 30 s the model may pick", () => {
    const e = estimateCommand(
      "elevenlabs sfx",
      { "--prompt": "rain", "duration-seconds": undefined },
      { at: AT },
    );
    expect(e).toMatchObject({ status: "estimated", low_usd: 0.001, high_usd: 0.06 });
    expect(e.units.output_audio_seconds).toEqual({ low: 0.5, expected: 30, high: 30 });
  });

  it("accepts a numeric duration (MCP) and refuses lengths the API rejects", () => {
    expect(
      estimateCommand("elevenlabs sfx", { text: "x", "duration-seconds": 10 }, { at: AT }).high_usd,
    ).toBe(0.02);
    for (const bad of ["31", "0.1", "abc", "-1"]) {
      const e = estimateCommand("elevenlabs sfx", { text: "x", durationSeconds: bad }, { at: AT });
      expect(e).toMatchObject({ status: "unknown", reason: "missing_input" });
    }
    expect(estimateCommand("elevenlabs sfx", {}, { at: AT }).status).toBe("unknown");
  });

  it("enforces --max-cost only under the estimate policy", () => {
    const e = estimateCommand("elevenlabs sfx", { text: "x", durationSeconds: "3" }, { at: AT });
    expect(() => checkBudget(e, 1, "strict")).toThrow(/not a proven cap/);
    expect(() => checkBudget(e, 0.005, "estimate")).toThrow(BudgetError);
    expect(() => checkBudget(e, 0.006, "estimate")).not.toThrow();
  });
});

describe("elevenlabs music cost", () => {
  it("prices --music-length-ms per second of music", () => {
    const e = estimateCommand(
      "elevenlabs music",
      { prompt: "x", musicLengthMs: "14000", model: "music_v1" },
      { at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      model: "music_v1",
      high_usd: 0.035,
      upper_bound: "estimated",
      units: { output_audio_seconds: { high: 14 } },
    });
    expect(e.rate?.id).toBe("elevenlabs/music@api");
    expect(() => checkBudget(e, 0.01, "estimate")).toThrow(/exceeds --max-cost/);
  });

  it("prices an omitted length at the 10 minutes the model may pick", () => {
    const e = estimateCommand("elevenlabs music", { prompt: "x" }, { at: AT });
    expect(e).toMatchObject({ status: "estimated", model: "music_v1", high_usd: 1.5 });
  });

  it("refuses lengths outside 3 s..10 min and unknown models", () => {
    for (const bad of ["2999", "600001"]) {
      expect(
        estimateCommand("elevenlabs music", { prompt: "x", musicLengthMs: bad }, { at: AT }).status,
      ).toBe("unknown");
    }
    expect(
      estimateCommand("elevenlabs music", { prompt: "x", model: "music_v9" }, { at: AT }).reason,
    ).toBe("no_price");
  });

  it("prices a --plan from the total its sections or chunks set", () => {
    const v1 = path.join(dir, "v1.json");
    fs.writeFileSync(
      v1,
      JSON.stringify({ sections: [{ duration_ms: 20000 }, { duration_ms: 40000 }] }),
    );
    const v2 = path.join(dir, "v2.json");
    fs.writeFileSync(v2, JSON.stringify({ chunks: [{ duration_ms: 30000 }] }));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ sections: [{ lines: [] }] }));
    expect(musicPlanLengthMs(v1)).toBe(60000);
    expect(musicPlanLengthMs(v2)).toBe(30000);
    expect(musicPlanLengthMs(bad)).toBeUndefined();
    expect(musicPlanLengthMs(path.join(dir, "missing.json"))).toBeUndefined();

    const e = estimateCommand("elevenlabs music", { plan: v1 }, { at: AT, planLengthMs: 60000 });
    expect(e).toMatchObject({ status: "estimated", high_usd: 0.15 });
    expect(e.assumptions).toContain("Priced on the plan's total 60 s of music.");
    // Without a readable plan (MCP, or a broken file) the run is not priced.
    expect(estimateCommand("elevenlabs music", { plan: v1 }, { at: AT })).toMatchObject({
      status: "unknown",
      reason: "missing_input",
    });
  });
});
