/**
 * Optional live checks against the real Sume API. Skipped unless
 * MULTIX_LIVE_SUME=1 and SUME_API_KEY are set; never prints the key.
 *
 * By default it only reads the public catalogue and asks the free estimate
 * endpoint for a quote. A paid image job runs only with the extra opt-in
 * MULTIX_LIVE_SUME_PAID=1, an explicit MULTIX_LIVE_SUME_MODEL, and
 * MULTIX_LIVE_SUME_MAX_USD; it is skipped when the quote exceeds that limit.
 */

import { describe, expect, it } from "vitest";
import { readSumeCatalog } from "../../../../src/providers/sume/catalog.js";
import { SumeClient } from "../../../../src/providers/sume/client.js";
import { parseUsd } from "../../../../src/providers/sume/models.js";

const key = process.env.SUME_API_KEY?.trim();
const enabled = process.env.MULTIX_LIVE_SUME === "1" && Boolean(key);
const paidModel = process.env.MULTIX_LIVE_SUME_MODEL?.trim();
const maxUsd = Number(process.env.MULTIX_LIVE_SUME_MAX_USD);
const paid =
  enabled &&
  process.env.MULTIX_LIVE_SUME_PAID === "1" &&
  Boolean(paidModel) &&
  Number.isFinite(maxUsd) &&
  maxUsd > 0;

const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
  globalThis.fetch(input, init);

describe.skipIf(!enabled)("sume live (free: catalogue and quote)", () => {
  it("reads the catalogue and quotes a text-to-image model", async () => {
    const { catalog } = await readSumeCatalog(fetchFn);
    const model = catalog.models.find(
      (m) => m.kind === "image" && m.capabilities.text_to_image === true,
    );
    expect(model).toBeDefined();
    const client = new SumeClient({ apiKey: key ?? "", fetch: fetchFn });
    const quote = await client.estimate(model?.id ?? "", { num_images: 1 });
    expect(quote.currency).toBe("USD");
    expect(parseUsd(quote.usd)).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe.skipIf(!paid)("sume live (paid, explicit opt-in)", () => {
  it("runs one image job within MULTIX_LIVE_SUME_MAX_USD", async (ctx) => {
    const client = new SumeClient({ apiKey: key ?? "", fetch: fetchFn });
    const input = { prompt: "a small red cube on a white table", num_images: 1 };
    const quote = await client.estimate(paidModel ?? "", input);
    const usd = parseUsd(quote.usd) ?? Number.POSITIVE_INFINITY;
    if (usd > maxUsd) ctx.skip();
    const submitted = await client.generateImage(
      { model: paidModel ?? "", ...input },
      { idempotencyKey: globalThis.crypto.randomUUID() },
    );
    const final = await client.waitForJob(submitted.job.id, { timeoutMs: 300_000 });
    expect(final.status).toBe("completed");
    const result = await client.getResult(final.id);
    expect(result.artifacts.length).toBeGreaterThan(0);
  }, 320_000);
});
