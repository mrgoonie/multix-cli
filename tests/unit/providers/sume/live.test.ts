/**
 * Optional live smoke test against the real Sume API. Only the free
 * endpoints are called: the public catalog and the non-billable estimate.
 * Skipped unless MULTIX_LIVE_TESTS=1 and SUME_API_KEY are both set. Never
 * prints the key.
 */

import { describe, expect, it } from "vitest";
import { fetchSumeCatalog, routerFor } from "../../../../src/providers/sume/catalog.js";
import { SumeClient } from "../../../../src/providers/sume/client.js";

const apiKey = process.env.SUME_API_KEY;
const enabled = process.env.MULTIX_LIVE_TESTS === "1" && Boolean(apiKey);

describe.skipIf(!enabled)("Sume live (free endpoints only)", () => {
  it("reads the catalog and prices one image model without billing", async () => {
    const { models } = await fetchSumeCatalog({});
    const model = models.find((m) => routerFor(m) === "image" && m.capabilities?.text_to_image);
    expect(model).toBeDefined();
    const client = new SumeClient({ apiKey: apiKey as string });
    const quote = await client.estimate(model?.id as string, { prompt: "a red apple" });
    expect(quote.usd_micros).toBeGreaterThan(0);
  }, 60_000);
});
