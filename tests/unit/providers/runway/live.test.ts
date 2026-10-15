/**
 * Optional live smoke test against the real Runway API. Skipped unless
 * MULTIX_LIVE_TESTS=1 and RUNWAYML_API_SECRET are set. Runs one Gen-4 Image
 * task at the smallest ratio (a few credits); never prints the secret.
 */

import { describe, expect, it } from "vitest";
import { RunwayClient, assertSucceeded } from "../../../../src/providers/runway/client.js";

const secret = process.env.RUNWAYML_API_SECRET;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(secret);

describe.skipIf(!enabled)("runway live smoke", () => {
  it("runs gen4_image to a succeeded task with an output URL", async () => {
    const client = new RunwayClient({ apiKey: secret ?? "" });
    const created = await client.createTextToImage({
      model: "gen4_image",
      promptText: "a small red cube on a white table",
      ratio: "720:720",
    });
    const final = assertSucceeded(await client.waitForTask(created.id, { timeoutMs: 300_000 }));
    expect(final.output?.length).toBeGreaterThan(0);
  }, 320_000);
});
