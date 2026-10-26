/**
 * Optional live smoke test against the real ElevenLabs API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and ELEVENLABS_API_KEY are set. Synthesizes "Hi." once
 * with eleven_v4 and once with eleven_v4_turbo (about 5 characters of credits
 * in total) and never prints the key.
 */

import { describe, expect, it } from "vitest";
import { apiPostBinaryWithHeaders } from "../../../../src/providers/elevenlabs/client.js";
import { TASK_DEFAULTS } from "../../../../src/providers/elevenlabs/models.js";
import { buildTtsRequest } from "../../../../src/providers/elevenlabs/tts-request.js";

const apiKey = process.env.ELEVENLABS_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(apiKey);

describe.skipIf(!enabled)("elevenlabs live smoke", () => {
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
});
