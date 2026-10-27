import { describe, expect, it } from "vitest";
import { checkBudget, estimateCommand, pricedCommands } from "../../../src/budget/command-cost.js";
import { SPEECH_ADAPTERS } from "../../../src/commands/speech/speech-adapters.js";
import { BudgetError } from "../../../src/core/errors.js";

const AT = new Date("2026-10-26T12:00:00Z");
const TEXT = "Xin chào thế giới";
const speech = (options: Record<string, unknown>, defaults = {}) =>
  estimateCommand("speech generate", options, { at: AT, ...defaults });

describe("speech generate estimates", () => {
  it("is a priced command", () => {
    expect(pricedCommands()).toContain("speech generate");
  });

  it("prices an ElevenLabs route like elevenlabs tts, with a proven ceiling", () => {
    const viaSpeech = speech({ provider: "elevenlabs", text: TEXT });
    const direct = estimateCommand("elevenlabs tts", { text: TEXT }, { at: AT });
    expect(viaSpeech).toMatchObject({
      status: "estimated",
      upper_bound: "proven",
      provider: "elevenlabs",
      high_usd: direct.high_usd,
    });
  });

  it("prices a Gemini route like gemini generate-speech, counting --style in the high end", () => {
    const plain = speech({ provider: "gemini", text: TEXT });
    const styled = speech({
      provider: "gemini",
      text: TEXT,
      style: "warm, unhurried, a little amused",
    });
    const direct = estimateCommand(
      "gemini generate-speech",
      { text: TEXT, style: "warm, unhurried, a little amused" },
      { at: AT },
    );
    expect(plain).toMatchObject({ status: "estimated", upper_bound: "estimated" });
    expect(styled.high_usd).toBe(direct.high_usd);
    expect(styled.high_usd ?? 0).toBeGreaterThan(plain.high_usd ?? 0);
  });

  it("uses the caller's default model and infers the provider from a model only one serves", () => {
    const lite = speech(
      { provider: "gemini", text: TEXT },
      { speechModels: { gemini: "gemini-2.5-pro-preview-tts" } },
    );
    expect(lite.model).toBe("gemini-2.5-pro-preview-tts");
    expect(speech({ model: "eleven_v3", text: TEXT })).toMatchObject({
      status: "estimated",
      provider: "elevenlabs",
      model: "eleven_v3",
    });
  });

  it("counts ElevenLabs previous/next text from --extra in the high end (record or repeated strings)", () => {
    const base = speech({ provider: "elevenlabs", text: TEXT });
    const fromRecord = speech({
      provider: "elevenlabs",
      text: TEXT,
      extra: { "elevenlabs.previous_text": "Before this.", "elevenlabs.next_text": "After." },
    });
    const fromList = speech({
      provider: "elevenlabs",
      text: TEXT,
      extra: ["elevenlabs.previous_text=Before this.", "elevenlabs.next_text=After."],
    });
    expect(fromRecord.high_usd ?? 0).toBeGreaterThan(base.high_usd ?? 0);
    expect(fromList.high_usd).toBe(fromRecord.high_usd);
  });

  it("prices a fallback plan at its most expensive route", () => {
    const flash = speech({ provider: "elevenlabs", model: "eleven_flash_v2_5", text: TEXT });
    const v3 = speech({ provider: "elevenlabs", model: "eleven_v3", text: TEXT });
    expect(v3.high_usd ?? 0).toBeGreaterThan(flash.high_usd ?? 0);
    const plan = speech({
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      fallback: ["elevenlabs:eleven_v3"],
      text: TEXT,
    });
    expect(plan).toMatchObject({ status: "estimated", model: "eleven_v3", high_usd: v3.high_usd });
    expect(plan.upper_bound).toBe("proven");
    expect(plan.assumptions.join(" ")).toContain("most expensive of 2 routes");
  });

  it("a plan mixing a proven and an estimated route has only an estimated ceiling", () => {
    const plan = speech({
      provider: "elevenlabs",
      fallback: "gemini",
      text: TEXT,
    });
    expect(plan.status).toBe("estimated");
    expect(plan.upper_bound).toBe("estimated");
  });

  it("is unknown when any route is unpriced, so --max-cost fails closed", () => {
    const plan = speech({ provider: "elevenlabs", fallback: ["openai"], text: TEXT });
    expect(plan).toMatchObject({ status: "unknown", reason: "unsupported", high_usd: null });
    expect(plan.detail).toContain("openai/");
    expect(() => checkBudget(plan, 100, "estimate")).toThrow(BudgetError);
    expect(speech({ provider: "minimax", text: TEXT }).status).toBe("unknown");
  });

  it("is unknown without text or a resolvable route", () => {
    expect(speech({ provider: "gemini" })).toMatchObject({
      status: "unknown",
      reason: "missing_input",
    });
    expect(speech({ text: TEXT })).toMatchObject({ status: "unknown", reason: "missing_input" });
    expect(speech({ provider: "nope", text: TEXT }).status).toBe("unknown");
    expect(speech({ provider: "gemini", fallback: ["nope"], text: TEXT }).status).toBe("unknown");
  });

  it("prices text a CLI caller read from --text-file, and accepts MCP flag spellings", () => {
    const fromFile = speech({ provider: "elevenlabs" }, { text: `  ${TEXT}\n` });
    const fromFlag = speech({ "--provider": "elevenlabs", "--text": TEXT });
    expect(fromFile).toMatchObject({ status: "estimated", text: { characters: 17 } });
    expect(fromFlag.high_usd).toBe(fromFile.high_usd);
  });

  it("prices the default model each priced provider's adapter runs", () => {
    for (const provider of ["gemini", "elevenlabs", "fish"] as const) {
      expect(speech({ provider, text: TEXT }).model).toBe(SPEECH_ADAPTERS[provider].defaultModel());
    }
  });

  it("a fallback plan's range spans its routes and expects the primary route's cost", () => {
    const flash = speech({ provider: "elevenlabs", model: "eleven_flash_v2_5", text: TEXT });
    const plan = speech({
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      fallback: ["elevenlabs:eleven_v3"],
      text: TEXT,
    });
    expect(plan.low_usd).toBe(flash.low_usd);
    expect(plan.expected_usd).toBe(flash.expected_usd);
    expect(plan.high_usd ?? 0).toBeGreaterThan(flash.high_usd ?? 0);
  });

  it("names no empty model in the refusal of an unresolvable route", () => {
    const unknown = speech({ text: TEXT });
    expect(() => checkBudget(unknown, 1, "strict")).toThrow(/cost of speech is unknown/);
  });
});

describe("fish tts estimates", () => {
  const PROMO = new Date("2026-11-01T12:00:00Z");
  const LIST = new Date("2026-12-01T12:00:00Z");
  const bytes = new TextEncoder().encode(TEXT).byteLength;

  it("prices UTF-8 bytes, not characters, at the Drama 3 promotion and list price", () => {
    expect(bytes).toBeGreaterThan(TEXT.length);
    const promo = estimateCommand("fish tts", { text: TEXT }, { at: PROMO });
    expect(promo).toMatchObject({ status: "estimated", provider: "fish", model: "drama-3" });
    expect(promo.expected_usd).toBeCloseTo((bytes * 10) / 1_000_000, 12);
    const list = estimateCommand("fish tts", { text: TEXT }, { at: LIST });
    expect(list.expected_usd).toBeCloseTo((bytes * 50) / 1_000_000, 12);
  });

  it("follows --model, the caller's default model and text read from a file", () => {
    const s2 = estimateCommand("fish tts", { text: TEXT, model: "s2.1-pro" }, { at: PROMO });
    expect(s2.expected_usd).toBeCloseTo((bytes * 15) / 1_000_000, 12);
    const free = estimateCommand("fish tts", {}, { at: PROMO, text: TEXT, model: "s2.1-pro-free" });
    expect(free).toMatchObject({ status: "estimated", expected_usd: 0 });
  });

  it("is unknown for a model with no price, so --max-cost fails closed instead of pricing it at $0", () => {
    const unknown = estimateCommand("fish tts", { text: TEXT, model: "drama-4" }, { at: PROMO });
    expect(unknown.status).not.toBe("estimated");
    expect(() => checkBudget(unknown, 1, "strict")).toThrow(BudgetError);
  });

  it("prices speech generate --provider fish like fish tts", () => {
    const viaSpeech = speech({ provider: "fish", text: TEXT });
    const direct = estimateCommand("fish tts", { text: TEXT }, { at: AT });
    expect(viaSpeech).toMatchObject({ status: "estimated", provider: "fish", model: "drama-3" });
    expect(viaSpeech.high_usd).toBe(direct.high_usd);
    expect(pricedCommands()).toContain("fish tts");
  });
});
