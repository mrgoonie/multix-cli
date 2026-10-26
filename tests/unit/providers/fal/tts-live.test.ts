/**
 * Optional live smoke test against fal text-to-speech. Skipped unless
 * MULTIX_LIVE_TESTS=1 and FAL_KEY (or FAL_API_KEY) are set. Speaks one short
 * sentence on each verified schema family (Gemini prompt/voice, ElevenLabs
 * text/output_format) and checks the saved bytes are the container named.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../../../src/core/logger.js";
import { createFalClient } from "../../../../src/providers/fal/client.js";
import { submitFalRequest, waitForFalResult } from "../../../../src/providers/fal/run-helpers.js";
import { buildSpeechRequest } from "../../../../src/providers/fal/speech-input.js";
import { expectedAudioExt } from "../../../../src/providers/fal/speech-models.js";
import { saveSpeechAudio } from "../../../../src/providers/fal/speech-output.js";

const enabled =
  process.env.MULTIX_LIVE_TESTS === "1" && Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY);

describe.skipIf(!enabled)("fal tts live smoke", () => {
  let outDir = "";
  const logger = createLogger({ verbose: false, stderr: true });
  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-fal-tts-live-"));
  });
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const cases = [
    { model: "google/gemini-3.8-flash-lite-tts", voice: "Puck", ext: "wav" },
    { model: "elevenlabs/tts/eleven-v4-turbo", format: "opus_48000_64", ext: "ogg" },
  ];
  for (const c of cases) {
    it(`${c.model} saves verified .${c.ext} audio`, async () => {
      const { ext: _ext, ...flags } = c;
      const request = buildSpeechRequest({ ...flags, text: "Hello." });
      const client = createFalClient();
      const submit = await submitFalRequest(client, c.model, request.input, logger);
      const result = await waitForFalResult({ client, model: c.model, submit, logger });
      const saved = await saveSpeechAudio({
        result,
        outDir,
        requestId: submit.request_id,
        ...(request.format
          ? { expectedExt: expectedAudioExt(request.profile, request.format) }
          : {}),
        logger,
      });
      expect(saved).toMatchObject({ format: c.ext, verified: true });
      expect(saved.bytes).toBeGreaterThan(100);
    }, 200_000);
  }
});
