/**
 * Optional live smoke test against the real TopView APIs. Skipped unless
 * MULTIX_LIVE_TOPVIEW=1 and the credentials are set. Read-only: it reads the
 * legacy credit balance and looks up a prediction id that does not exist, so
 * nothing is created or billed. Key values are never printed.
 */

import { describe, expect, it } from "vitest";
import { TopviewClient } from "../../../../src/providers/topview/client.js";
import {
  TopviewPlatformClient,
  TopviewPlatformError,
} from "../../../../src/providers/topview/platform-client.js";

const live = process.env.MULTIX_LIVE_TOPVIEW === "1";
const apiKey = process.env.TOPVIEW_API_KEY ?? "";
const uid = process.env.TOPVIEW_UID ?? "";
const platformKey = process.env.TOPVIEW_PLATFORM_API_KEY ?? "";

describe.skipIf(!(live && apiKey && uid))("topview legacy API live (read-only)", () => {
  it("reads the remaining credits", async () => {
    const detail = await new TopviewClient({ apiKey, uid }).getCredits();
    expect(typeof (detail.remainCredit ?? 0)).toBe("number");
    expect(JSON.stringify(detail)).not.toContain(apiKey);
  }, 30_000);
});

describe.skipIf(!(live && platformKey))("topview API Platform live (read-only)", () => {
  it("authenticates and reports an unknown prediction as not found", async () => {
    const client = new TopviewPlatformClient({ apiKey: platformKey });
    const error = await client.getPrediction("multixLiveProbeDoesNotExist").catch((e) => e);
    expect(error).toBeInstanceOf(TopviewPlatformError);
    expect([400, 404]).toContain((error as TopviewPlatformError).status);
    expect(String(error.message)).not.toContain(platformKey);
  }, 30_000);
});
