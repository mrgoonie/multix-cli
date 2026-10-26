import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, parseMaxCost } from "../../../src/budget/command-cost.js";
import { countText, estimateCost } from "../../../src/budget/cost-estimate.js";
import {
  MAX_PRICE_AGE_DAYS,
  PRICING_CATALOG,
  type PriceEntry,
  resolveRate,
} from "../../../src/budget/pricing-catalog.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-26T12:00:00Z");
const VI_NFC = "Xin chào thế giới";
const VI_NFD = VI_NFC.normalize("NFD");

describe("pricing catalog", () => {
  it("every entry is verified, dated and sourced from the provider's own pricing page", () => {
    for (const e of PRICING_CATALOG) {
      expect(e.verified).toBe(true);
      expect(e.last_checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.source).toMatch(
        /^https:\/\/(ai\.google\.dev|elevenlabs\.io|docs\.fish\.audio|openrouter\.ai)\//,
      );
      expect(e.windows.length).toBeGreaterThan(0);
    }
  });

  it("lists each model once, and OpenRouter ids in lower case as OpenRouter matches them", () => {
    const seen = new Set<string>();
    for (const e of PRICING_CATALOG) {
      for (const m of e.models) {
        const key = `${e.provider} ${m}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
        if (e.provider === "openrouter") expect(m).toBe(m.toLowerCase());
      }
    }
  });

  it("unknown, unverified or stale prices resolve to unknown, never $0", () => {
    expect(resolveRate("gemini", "gemini-9-tts", AT)).toMatchObject({
      ok: false,
      reason: "no_price",
    });
    const unverified: PriceEntry = { ...(PRICING_CATALOG[0] as PriceEntry), verified: false };
    expect(resolveRate("gemini", "gemini-3.8-flash-tts", AT, [unverified])).toMatchObject({
      ok: false,
      reason: "unverified",
    });
    const later = new Date(Date.parse("2026-10-26") + (MAX_PRICE_AGE_DAYS + 1) * 86_400_000);
    expect(resolveRate("gemini", "gemini-3.8-flash-tts", later)).toMatchObject({
      ok: false,
      reason: "stale",
    });
  });

  it("an expired promotion switches to the list price (Fish drama-3)", () => {
    const promo = resolveRate("fish", "drama-3", new Date("2026-11-01T00:00:00Z"));
    const list = resolveRate("fish", "drama-3", new Date("2026-11-12T17:00:00Z"));
    expect(promo.ok && promo.rate.components[0]?.usd).toBe(10);
    expect(promo.ok && promo.rate.label).toBe("promotion");
    expect(list.ok && list.rate.components[0]?.usd).toBe(50);
    expect(list.ok && list.rate.label).toBeUndefined();
  });

  it("near a price change the ceiling uses the higher price", () => {
    const eve = resolveRate("gemini", "gemini-3.8-flash-tts", new Date("2026-12-31T20:00:00Z"));
    expect(eve.ok && eve.rate.components.find((c) => c.meter === "output_audio_tokens")?.usd).toBe(
      9,
    );
    expect(
      eve.ok && eve.rate.upper_components.find((c) => c.meter === "output_audio_tokens")?.usd,
    ).toBe(18);
  });
});

describe("unit counting", () => {
  it("counts Vietnamese characters as code points and bytes as UTF-8", () => {
    expect(countText(VI_NFC)).toEqual({
      characters: 17,
      nfc_characters: 17,
      utf8_bytes: 22,
      utf16_units: 17,
    });
    // Decomposed input has more code points (billed characters) but the same NFC length.
    const nfd = countText(VI_NFD);
    expect(nfd.characters).toBeGreaterThan(17);
    expect(nfd.nfc_characters).toBe(17);
    expect(nfd.utf8_bytes).toBeGreaterThan(22);
  });

  it("counts emoji and CJK as one character each", () => {
    expect(countText("ok 👍")).toMatchObject({ characters: 4, utf8_bytes: 7, utf16_units: 5 });
    expect(countText("你好")).toMatchObject({ characters: 2, utf8_bytes: 6 });
  });
});

describe("estimates", () => {
  it("ElevenLabs bills characters: proven ceiling, context text only in the high end", () => {
    const e = estimateCost({
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      text: VI_NFC,
      extra_text: ["Trước đó."],
      at: AT,
    });
    expect(e).toMatchObject({ status: "estimated", upper_bound: "proven" });
    expect(e.units.characters).toEqual({ low: 17, expected: 17, high: 26 });
    expect(e.expected_usd).toBeCloseTo(17 * 0.00008, 9);
    expect(e.high_usd).toBeCloseTo(26 * 0.00008, 9);
  });

  it("Fish bills UTF-8 bytes, not characters", () => {
    const e = estimateCost({ provider: "fish", model: "s2-pro", text: VI_NFC, at: AT });
    expect(e.units.utf8_bytes).toEqual({ low: 22, expected: 22, high: 22 });
    expect(e.units.characters).toBeUndefined();
    expect(e.high_usd).toBeCloseTo((22 * 15) / 1e6, 9);
    expect(e.upper_bound).toBe("proven");
  });

  it("Gemini TTS bills text tokens in and audio tokens out: ceiling is only estimated", () => {
    const e = estimateCost({
      provider: "gemini",
      model: "gemini-3.8-flash-tts",
      text: "a".repeat(140),
      at: AT,
    });
    expect(e.upper_bound).toBe("estimated");
    expect(e.units.output_audio_seconds?.expected).toBe(10);
    expect(e.units.output_audio_tokens?.expected).toBe(250);
    expect(e.rate?.effective_until).toBe("2027-01-01T00:00:00Z");
    expect(e.low_usd ?? 0).toBeLessThan(e.expected_usd ?? 0);
    expect(e.expected_usd ?? 0).toBeLessThan(e.high_usd ?? 0);
  });

  it("commands without an estimator are unknown, not free", () => {
    const e = estimateCommand("openai generate", { prompt: "x" }, { at: AT });
    expect(e).toMatchObject({ status: "unknown", reason: "unsupported", high_usd: null });
    expect(estimateCommand("elevenlabs tts", {}, { at: AT })).toMatchObject({
      status: "unknown",
      reason: "missing_input",
    });
  });

  it("reads kebab-case (MCP) and camelCase (commander) options alike", () => {
    const mcp = estimateCommand(
      "elevenlabs tts",
      { text: "hi", "previous-text": "abc" },
      { at: AT },
    );
    const cli = estimateCommand("elevenlabs tts", { text: "hi", previousText: "abc" }, { at: AT });
    expect(mcp.units.characters?.high).toBe(5);
    expect(cli.units).toEqual(mcp.units);
    const flags = estimateCommand(
      "elevenlabs tts",
      { "--text": "hi", "--previous-text": "abc" },
      { at: AT },
    );
    expect(flags.units).toEqual(mcp.units);
  });
});

describe("openrouter estimates", () => {
  it("prices OpenRouter TTS per character from the models catalog: proven ceiling", () => {
    const e = estimateCommand(
      "openrouter tts",
      { text: VI_NFC, model: "elevenlabs/eleven-v4", instructions: "calm" },
      { at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      provider: "openrouter",
      upper_bound: "proven",
      units: { characters: { low: 17, expected: 17, high: 21 } },
      rate: {
        id: "openrouter/elevenlabs-multilingual@api",
        source: "https://openrouter.ai/api/v1/models?output_modalities=speech",
      },
    });
    // $0.00008 per character.
    expect(e.expected_usd).toBeCloseTo(17 * 0.00008, 9);
    expect(e.high_usd).toBeCloseTo(21 * 0.00008, 9);
  });

  it("defaults to the CLI's TTS model, matches ids ignoring case, and knows canonical slugs", () => {
    const d = estimateCommand("openrouter tts", { text: "hello" }, { at: AT });
    expect(d).toMatchObject({ model: "google/gemini-3.8-flash-tts", upper_bound: "estimated" });
    expect(d.units.output_audio_tokens).toBeDefined();
    const upper = estimateCommand(
      "openrouter tts",
      { text: "hello", model: "ElevenLabs/Eleven-V4-Turbo" },
      { at: AT },
    );
    expect(upper.rate?.id).toBe("openrouter/elevenlabs-flash-turbo@api");
    const slug = estimateCommand(
      "openrouter tts",
      { text: "hello", model: "minimax/speech-2.8-hd-20260716" },
      { at: AT },
    );
    expect(slug.rate?.id).toBe("openrouter/minimax-speech-hd@api");
  });

  it("prices Fish models on OpenRouter by UTF-8 bytes, never fewer than characters", () => {
    const e = estimateCommand(
      "openrouter tts",
      { text: VI_NFC, model: "fish-audio/s2.1-pro" },
      { at: AT },
    );
    expect(e.units.utf8_bytes?.high).toBe(22);
    expect(e.high_usd).toBeCloseTo(22 * 0.000015, 9);
  });

  it("Seed Audio bills output seconds: the ceiling is only estimated", () => {
    const e = estimateCommand(
      "openrouter tts",
      { text: "a".repeat(140), model: "bytedance-seed/seed-audio-1-0" },
      { at: AT },
    );
    expect(e.upper_bound).toBe("estimated");
    expect(e.units.output_audio_seconds).toEqual({ low: 5.6, expected: 10, high: 23.3 });
    expect(e.expected_usd).toBeCloseTo(10 * 0.0025, 9);
  });

  it("a price with a known end and no known successor turns unknown a day before it", () => {
    const drama = { text: "hi", model: "fish-audio/drama-3" };
    const e = estimateCommand("openrouter tts", drama, { at: AT });
    expect(e.status).toBe("estimated");
    expect(e.assumptions.join(" ")).toContain("Promotional price ends");
    for (const at of ["2026-11-11T17:00:01Z", "2026-11-13T00:00:00Z"]) {
      expect(estimateCommand("openrouter tts", drama, { at: new Date(at) })).toMatchObject({
        status: "unknown",
        reason: "no_window",
      });
    }
    expect(
      estimateCommand("openrouter tts", drama, { at: new Date("2026-11-11T16:59:59Z") }).status,
    ).toBe("estimated");
  });

  it("prices a model at its most expensive OpenRouter endpoint, not the cheapest listed", () => {
    // whisper-large-v3-turbo: DeepInfra $0.00000333/s, Groq $0.0000111/s.
    const turbo = estimateCommand(
      "openrouter transcribe",
      { input: "a.mp3" },
      { audioSeconds: 600, at: AT },
    );
    expect(turbo.expected_usd).toBeCloseTo(600 * 0.0000111111111111, 6);
    // kokoro-82m: $0.62/M characters listed, $4/M on its other endpoint.
    const kokoro = estimateCommand(
      "openrouter tts",
      { text: "a".repeat(1000), model: "hexgrad/kokoro-82m" },
      { at: AT },
    );
    expect(kokoro.high_usd).toBeCloseTo(0.004, 9);
  });

  it("counts astral characters twice in the high end, in case UTF-16 units are billed", () => {
    const e = estimateCommand(
      "openrouter tts",
      { text: "ok 👍", model: "elevenlabs/eleven-v4" },
      { at: AT },
    );
    expect(e.units.characters).toEqual({ low: 4, expected: 4, high: 5 });
    expect(e.upper_bound).toBe("proven");
  });

  it("says which options can be priced when the text comes from a file", () => {
    expect(estimateCommand("openrouter tts", { textFile: "a.txt" }, { at: AT }).detail).toContain(
      "--text-file",
    );
  });

  it("models OpenRouter has not priced in a known unit stay unknown", () => {
    for (const model of ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"]) {
      expect(
        estimateCommand(
          "openrouter transcribe",
          { input: "a.mp3", model },
          { audioSeconds: 10, at: AT },
        ),
      ).toMatchObject({ status: "unknown", reason: "no_price" });
    }
    expect(
      estimateCommand("openrouter tts", { text: "hi", model: "x/unknown" }, { at: AT }),
    ).toMatchObject({ status: "unknown", reason: "no_price" });
  });

  it("prices transcription per second of input audio, rounded up to a minute at the high end", () => {
    const e = estimateCommand(
      "openrouter transcribe",
      { input: "talk.mp3", model: "openai/whisper-1" },
      { audioSeconds: 90.5, at: AT },
    );
    expect(e).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      units: { input_audio_seconds: { low: 90.5, expected: 90.5, high: 120 } },
      rate: { id: "openrouter/stt-100@api" },
    });
    // whisper-1: $0.006 per minute.
    expect(e.expected_usd).toBeCloseTo(90.5 * 0.0001, 9);
    expect(e.high_usd).toBeCloseTo(0.012, 9);
    // Within 5% of a minute boundary, the ceiling moves to the next minute.
    const edge = estimateCommand(
      "openrouter transcribe",
      { input: "talk.mp3" },
      { audioSeconds: 58, at: AT },
    );
    expect(edge.model).toBe("openai/whisper-large-v3-turbo");
    expect(edge.units.input_audio_seconds?.high).toBe(120);
  });

  it("transcription without a measured audio length is unknown, never $0", () => {
    expect(
      estimateCommand("openrouter transcribe", { input: "https://x.test/a.mp3" }, { at: AT }),
    ).toMatchObject({ status: "unknown", reason: "missing_input", high_usd: null });
    for (const audioSeconds of [0, Number.NaN]) {
      expect(
        estimateCommand("openrouter transcribe", { input: "a.mp3" }, { audioSeconds, at: AT })
          .status,
      ).toBe("unknown");
    }
    expect(estimateCommand("openrouter transcribe", {}, { at: AT })).toMatchObject({
      reason: "missing_input",
      detail: expect.stringContaining("--input"),
    });
  });

  it("the guard admits a transcription whose proven ceiling fits and refuses one that does not", () => {
    const e = estimateCommand(
      "openrouter transcribe",
      { input: "talk.mp3", model: "openai/whisper-1" },
      { audioSeconds: 30, at: AT },
    );
    expect(() => checkBudget(e, 0.01, "strict")).not.toThrow();
    expect(() => checkBudget(e, 0.005, "strict")).toThrow(/exceeds --max-cost/);
  });
});

describe("spend guard", () => {
  const eleven = estimateCommand("elevenlabs tts", { text: "hello" }, { at: AT });
  const gemini = estimateCommand("gemini generate-speech", { text: "hello" }, { at: AT });
  const none = estimateCommand("openai generate", { prompt: "x" }, { at: AT });

  it("passes a proven ceiling under the limit and refuses one over it", () => {
    expect(() => checkBudget(eleven, 1, "strict")).not.toThrow();
    expect(() => checkBudget(eleven, 0.0001, "strict")).toThrow(/exceeds --max-cost/);
  });

  it("refuses an estimated ceiling unless the policy accepts it", () => {
    expect(() => checkBudget(gemini, 1, "strict")).toThrow(BudgetError);
    expect(() => checkBudget(gemini, 1, "estimate")).not.toThrow();
  });

  it("refuses an unknown price whatever the policy", () => {
    for (const policy of ["strict", "estimate"] as const) {
      try {
        checkBudget(none, 100, policy);
        expect.unreachable();
      } catch (error) {
        expect((error as BudgetError).code).toBe("BUDGET_UNPROVEN");
      }
    }
  });

  it("rejects malformed limits", () => {
    expect(parseMaxCost("0.25")).toBe(0.25);
    expect(parseMaxCost(0)).toBe(0);
    for (const bad of ["", "abc", "-1", "Infinity", "0x10", "1e3"]) {
      expect(() => parseMaxCost(bad)).toThrow();
    }
  });
});
