/**
 * Optional live smoke test against the real ElevenLabs API (paid: at most
 * BUDGET_CHARS characters per model, about 6 in practice).
 * Skipped unless MULTIX_LIVE_TESTS=1 and ELEVENLABS_API_KEY are both set.
 * Never prints the key.
 */

import { describe, expect, it } from "vitest";
import { apiGet, apiPostBinary } from "../../../../src/providers/elevenlabs/client.js";
import {
  ELEVENLABS_TTS_CAPS,
  ELEVENLABS_TTS_MODELS,
  TASK_DEFAULTS,
} from "../../../../src/providers/elevenlabs/models.js";
import { buildTtsRequest } from "../../../../src/providers/elevenlabs/tts-request.js";

const apiKey = process.env.ELEVENLABS_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(apiKey);
const BUDGET_CHARS = 10;

describe.skipIf(!enabled)("ElevenLabs live", () => {
  it("lists every CLI TTS model in the live catalog with matching limits (free)", async () => {
    const models = await apiGet<
      Array<{
        model_id: string;
        can_do_text_to_speech?: boolean;
        maximum_text_length_per_request?: number;
      }>
    >("models", apiKey as string);
    for (const id of ELEVENLABS_TTS_MODELS) {
      const live = models.find((m) => m.model_id === id);
      expect(live?.can_do_text_to_speech, id).toBe(true);
      expect(live?.maximum_text_length_per_request, id).toBe(ELEVENLABS_TTS_CAPS[id].maxChars);
    }
  }, 30_000);

  it.each(["eleven_v4", "eleven_v4_turbo"])(
    "%s returns audio and a provider-reported character cost within budget",
    async (model) => {
      const { payload } = buildTtsRequest({
        text: "Hi.",
        model,
        settings: { stability: 0.5, similarity_boost: 0.75 },
      });
      let cost: string | null = null;
      const bytes = await apiPostBinary(
        `text-to-speech/${TASK_DEFAULTS.ttsVoice}`,
        payload,
        apiKey as string,
        {
          query: { output_format: "mp3_22050_32" },
          onHeaders: (h) => {
            cost = h.get("character-cost");
          },
        },
      );
      expect(bytes.length).toBeGreaterThan(500);
      expect(Number(cost)).toBeGreaterThan(0);
      expect(Number(cost)).toBeLessThanOrEqual(BUDGET_CHARS);
    },
    60_000,
  );
});
