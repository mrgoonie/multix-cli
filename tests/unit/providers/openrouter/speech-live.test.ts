/**
 * Optional live smoke test against the real OpenRouter speech endpoint.
 * Skipped unless MULTIX_LIVE_TESTS=1 and OPENROUTER_API_KEY are set. Speaks
 * two words with Fish Audio Drama 3 (about $0.00002 at $2 per 1M characters).
 */

import { describe, expect, it } from "vitest";
import { buildOpenRouterHeaders } from "../../../../src/providers/openrouter/payload.js";
import { looksLikeMp3 } from "../../../../src/providers/openrouter/speech-audio.js";
import {
  createSpeech,
  findSpeechModel,
  listSpeechModels,
} from "../../../../src/providers/openrouter/speech-client.js";

const key = process.env.OPENROUTER_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(key);
const MODEL = "fish-audio/drama-3";

describe.skipIf(!enabled)("OpenRouter speech live smoke", () => {
  it("lists the model and returns mp3 audio with a generation id", async () => {
    expect(findSpeechModel(await listSpeechModels(), MODEL)).toBeDefined();
    const speech = await createSpeech({
      body: { model: MODEL, input: "Hello there.", response_format: "mp3" },
      headers: buildOpenRouterHeaders(key ?? ""),
      maxBytes: 5 * 1024 * 1024,
    });
    expect(speech.contentType.mime).toBe("audio/mpeg");
    expect(looksLikeMp3(speech.audio)).toBe(true);
    expect(speech.generationId).toMatch(/^gen-/);
  }, 120_000);
});
