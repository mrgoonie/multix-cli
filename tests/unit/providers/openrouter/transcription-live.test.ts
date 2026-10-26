/**
 * Optional live smoke test against the real OpenRouter transcription
 * endpoint. Skipped unless MULTIX_LIVE_TESTS=1 and OPENROUTER_API_KEY are set.
 * Speaks two words with Fish Audio Drama 3 and transcribes them with Whisper
 * Large V3 Turbo (well under $0.001 in total).
 */

import { describe, expect, it } from "vitest";
import { buildOpenRouterHeaders } from "../../../../src/providers/openrouter/payload.js";
import { createSpeech } from "../../../../src/providers/openrouter/speech-client.js";
import {
  createTranscription,
  findTranscriptionModel,
  listTranscriptionModels,
} from "../../../../src/providers/openrouter/transcription-client.js";

const key = process.env.OPENROUTER_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(key);
const MODEL = "openai/whisper-large-v3-turbo";

describe.skipIf(!enabled)("OpenRouter transcription live smoke", () => {
  it("lists the model and transcribes an uploaded mp3", async () => {
    expect(findTranscriptionModel(await listTranscriptionModels(), MODEL)).toBeDefined();
    const headers = buildOpenRouterHeaders(key ?? "");
    const speech = await createSpeech({
      body: { model: "fish-audio/drama-3", input: "Hello there.", response_format: "mp3" },
      headers,
      maxBytes: 5 * 1024 * 1024,
    });
    const out = await createTranscription({
      model: MODEL,
      audio: { kind: "bytes", data: speech.audio, format: "mp3" },
      language: "en",
      headers,
    });
    expect(out.text.toLowerCase()).toContain("hello");
    expect(out.generationId).toMatch(/^gen-/);
  }, 120_000);
});
