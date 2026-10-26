/**
 * Optional live smoke test against the real ElevenLabs API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and ELEVENLABS_API_KEY are set. Synthesizes "Hi." once
 * with eleven_v4 and once with eleven_v4_turbo (about 5 characters of credits
 * in total) plus once more with --clone-strength on eleven_v4, checks the
 * capability table against the free GET /v1/models and the unbilled 400s for
 * clone_strength and language_code, and never prints the key.
 */

import { describe, expect, it } from "vitest";
import { apiGet, apiPostBinaryWithHeaders } from "../../../../src/providers/elevenlabs/client.js";
import {
  ELEVENLABS_TTS_MODEL_CAPS,
  TASK_DEFAULTS,
} from "../../../../src/providers/elevenlabs/models.js";
import { buildTtsRequest } from "../../../../src/providers/elevenlabs/tts-request.js";

const apiKey = process.env.ELEVENLABS_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(apiKey);

interface LiveModel {
  model_id: string;
  can_use_style?: boolean;
  can_use_speaker_boost?: boolean;
  maximum_text_length_per_request?: number;
}

describe.skipIf(!enabled)("elevenlabs live smoke", () => {
  it("capability table matches the live model catalog", async () => {
    const live = await apiGet<LiveModel[]>("models", apiKey ?? "");
    for (const [id, caps] of Object.entries(ELEVENLABS_TTS_MODEL_CAPS)) {
      const m = live.find((x) => x.model_id === id);
      expect(m, id).toBeDefined();
      expect({ id, style: m?.can_use_style, speakerBoost: m?.can_use_speaker_boost }).toEqual({
        id,
        style: caps.style,
        speakerBoost: caps.speakerBoost,
      });
      expect(m?.maximum_text_length_per_request, id).toBe(caps.maxChars);
    }
  }, 30_000);

  for (const model of ["eleven_v4", "eleven_v4_turbo"]) {
    it(`${model} returns MP3 audio and a character-cost header`, async () => {
      const { payload, warnings } = buildTtsRequest({ text: "Hi.", model });
      expect(warnings).toEqual([]);
      const res = await apiPostBinaryWithHeaders(
        `text-to-speech/${TASK_DEFAULTS.ttsVoice}`,
        payload,
        apiKey ?? "",
        { query: { output_format: "mp3_22050_32" } },
      );
      expect(res.bytes.length).toBeGreaterThan(500);
      expect(Number(res.headers.get("character-cost"))).toBeGreaterThan(0);
    }, 60_000);
  }

  it("eleven_v4 accepts clone_strength from the CLI's request", async () => {
    const { payload } = buildTtsRequest({ text: "Hi.", model: "eleven_v4", cloneStrength: "0" });
    const res = await apiPostBinaryWithHeaders(
      `text-to-speech/${TASK_DEFAULTS.ttsVoice}`,
      payload,
      apiKey ?? "",
      { query: { output_format: "mp3_22050_32" } },
    );
    expect(res.bytes.length).toBeGreaterThan(500);
  }, 60_000);

  // Unbilled: the API refuses each of these with a 400 before synthesis.
  const refused = async (body: Record<string, unknown>) => {
    const err = await apiPostBinaryWithHeaders(
      `text-to-speech/${TASK_DEFAULTS.ttsVoice}`,
      { text: "Hi.", ...body },
      apiKey ?? "",
      { query: { output_format: "mp3_22050_32" } },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    return String((err as Error | undefined)?.message ?? "no error");
  };

  it("models without cloneStrength in the table answer 400 unsupported_model", async () => {
    for (const [id, caps] of Object.entries(ELEVENLABS_TTS_MODEL_CAPS)) {
      if (caps.cloneStrength) continue;
      const msg = await refused({ model_id: id, voice_settings: { clone_strength: 0 } });
      expect(msg, id).toMatch(/unsupported_model/);
    }
  }, 60_000);

  it("eleven_multilingual_v2 answers 400 unsupported_language outside its list", async () => {
    const msg = await refused({ model_id: "eleven_multilingual_v2", language_code: "vi" });
    expect(msg).toMatch(/unsupported_language/);
  }, 30_000);
});
