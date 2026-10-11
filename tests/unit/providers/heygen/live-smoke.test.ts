/**
 * Credential-gated live smoke test. Skipped unless MULTIX_LIVE_TESTS=1 and
 * HEYGEN_API_KEY are set. Calls read-only endpoints only (no credits spent).
 */

import { describe, expect, it } from "vitest";
import { HeygenClient } from "../../../../src/providers/heygen/client.js";

const apiKey = process.env.HEYGEN_API_KEY;
const live = process.env.MULTIX_LIVE_TESTS === "1" && !!apiKey;

describe.skipIf(!live)("HeyGen live (read-only)", () => {
  const client = () =>
    new HeygenClient({ apiKey: apiKey as string, baseUrl: process.env.HEYGEN_BASE_URL });

  it("GET /v3/users/me", async () => {
    const me = await client().getCurrentUser();
    expect(me).toBeTypeOf("object");
  });

  it("GET /v3/voices pages with a cursor", async () => {
    const page = await client().listVoices({ limit: 2 });
    expect(Array.isArray(page.items)).toBe(true);
    if (page.hasMore) expect(page.nextToken).toBeTruthy();
  });
});
