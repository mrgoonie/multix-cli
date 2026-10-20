import { describe, expect, it, vi } from "vitest";
import { outputStamp } from "../../../src/core/output-name.js";

describe("outputStamp", () => {
  it("is the epoch milliseconds followed by an 8-char hex suffix", () => {
    expect(outputStamp()).toMatch(/^\d{13}-[0-9a-f]{8}$/);
  });

  it("differs between calls in the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_955_000_000);
    try {
      const stamps = new Set(Array.from({ length: 1000 }, () => outputStamp()));
      expect(stamps.size).toBe(1000);
      for (const s of stamps) expect(s.startsWith("1760955000000-")).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
