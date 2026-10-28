/**
 * Optional live checks against the real TopView APIs. They make only free
 * reads (no task is created): each suite runs only when MULTIX_LIVE_TESTS=1
 * and that API's credentials are set. Never prints keys or signed URLs.
 */

import { describe, expect, it } from "vitest";
import { classifyError } from "../../../../src/core/error-classify.js";
import { TopviewLegacyClient } from "../../../../src/providers/topview/legacy-client.js";
import { TopviewPlatformClient } from "../../../../src/providers/topview/platform-client.js";

const live = process.env.MULTIX_LIVE_TESTS === "1";
const legacyKey = process.env.TOPVIEW_API_KEY;
const uid = process.env.TOPVIEW_UID;
const platformKey = process.env.TOPVIEW_API_PLATFORM_KEY;

describe.skipIf(!(live && legacyKey && uid))("TopView legacy API live", () => {
  it("issues an upload credential (no upload, no task)", async () => {
    const client = new TopviewLegacyClient({ apiKey: legacyKey as string, uid: uid as string });
    const cred = await client.uploadCredential("png");
    expect(cred.fileId).toMatch(/\S/);
    expect(cred.uploadUrl.startsWith("https://")).toBe(true);
  }, 30_000);
});

describe.skipIf(!(live && platformKey))("TopView API Platform live", () => {
  it("accepts the key on a read of a task that does not exist", async () => {
    const client = new TopviewPlatformClient({ apiKey: platformKey as string });
    const err = await client.getPrediction("multix-live-check-missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(classifyError(err).code).not.toBe("INVALID_KEY");
  }, 30_000);
});
