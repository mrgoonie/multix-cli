/**
 * Optional live smoke test against the real ElevenLabs API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and ELEVENLABS_API_KEY are set. Synthesizes "Hi." once
 * with eleven_v4 and once with eleven_v4_turbo (about 5 characters of credits
 * in total), checks the capability table against the free GET /v1/models
 * and the clone_strength rejection (a free 400), and never prints the key.
 */

import { describe, expect, it } from "vitest";
import { HttpError } from "../../../../src/core/errors.js";
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
      // v4 Turbo also carries clone_strength, so both bodies are checked live.
      const cloneStrength = model === "eleven_v4_turbo" ? "0" : undefined;
      const { payload, warnings } = buildTtsRequest({ text: "Hi.", model, cloneStrength });
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

  it("clone_strength is refused by a model the table says lacks it (free 400)", async () => {
    const err = await apiPostBinaryWithHeaders(
      `text-to-speech/${TASK_DEFAULTS.ttsVoice}`,
      {
        text: "Hi.",
        model_id: "eleven_v3",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, clone_strength: 0 },
      },
      apiKey ?? "",
      { query: { output_format: "mp3_22050_32" } },
    ).catch((e: unknown) => e);
    expect(ELEVENLABS_TTS_MODEL_CAPS.eleven_v3.cloneStrength).toBe(false);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).snippet).toMatch(/unsupported_model/);
  }, 30_000);
});
