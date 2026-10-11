/**
 * Optional live smoke test against the real Atlas Cloud API (paid, ~$0.003).
 * Skipped unless MULTIX_LIVE_TESTS=1 and ATLASCLOUD_API_KEY are both set.
 * Never prints the key or the output URL.
 */

import { describe, expect, it } from "vitest";
import {
  AtlasCloudClient,
  assertPredictionSucceeded,
} from "../../../../src/providers/atlascloud/client.js";
import { ATLAS_DEFAULT_MODELS } from "../../../../src/providers/atlascloud/models.js";
import { classifyOutputs } from "../../../../src/providers/atlascloud/prediction-output.js";

const apiKey = process.env.ATLASCLOUD_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(apiKey);

describe.skipIf(!enabled)("Atlas Cloud live", () => {
  it("generates one image with the default image model", async () => {
    const client = new AtlasCloudClient({ apiKey: apiKey as string });
    const spec = await client.getModelSpec(ATLAS_DEFAULT_MODELS.image);
    expect(spec?.endpoint).toBe("image");

    const submitted = await client.submit("image", {
      model: ATLAS_DEFAULT_MODELS.image,
      prompt: "a single red apple on a white table, studio photo",
      size: "512*512",
    });
    const final = await client.waitForPrediction(submitted.id, {
      timeoutMs: 120_000,
      intervalMs: 2000,
    });
    assertPredictionSucceeded(final);
    const outputs = classifyOutputs(final);
    expect(outputs.mode).toBe("media");
  }, 150_000);
});
