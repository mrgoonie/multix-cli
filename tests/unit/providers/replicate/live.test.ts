/**
 * Optional live smoke test against the real Replicate API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and REPLICATE_API_TOKEN (or REPLICATE_API_KEY) are set.
 * Runs one low-cost black-forest-labs/flux-schnell image prediction.
 */

import { describe, expect, it } from "vitest";
import { ReplicateClient, assertSucceeded } from "../../../../src/providers/replicate/client.js";
import { parseModelRef } from "../../../../src/providers/replicate/models.js";
import { extractOutput } from "../../../../src/providers/replicate/output.js";

const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(token);

describe.skipIf(!enabled)("replicate live smoke", () => {
  it("runs flux-schnell to a succeeded prediction with an image URL", async () => {
    const client = new ReplicateClient({ apiKey: token ?? "" });
    const created = await client.createPrediction({
      model: parseModelRef("black-forest-labs/flux-schnell"),
      input: { prompt: "a small red cube on white", num_outputs: 1 },
      preferWaitSeconds: 30,
    });
    const final = assertSucceeded(await client.waitForPrediction(created, { timeoutMs: 180_000 }));
    expect(extractOutput(final.output).media.length).toBeGreaterThan(0);
  }, 200_000);
});
