/**
 * Price book: freshness of a rate, quoting one rate at one configuration,
 * comparing a model family across providers, and listing offerings. Custom
 * sources keep the arithmetic readable; the real data is spot-checked at a
 * fixed date. Nothing here reads the network or the clock.
 */

import { describe, expect, it } from "vitest";
import type { PriceEntry } from "../../../src/budget/pricing-catalog.js";
import type { OfferingView, Quote, RateView } from "../../../src/catalog/catalog-types.js";
import type { MediaRateCard } from "../../../src/catalog/media-rate-cards.js";
import {
  PRICE_BOOK_VIEWS,
  offeringWithQuotes,
  priceBookPayload,
} from "../../../src/catalog/price-book-view.js";
import {
  type PriceBookSources,
  allRates,
  betterQuote,
  compareFamily,
  familyOf,
  filterOfferings,
  freshnessOf,
  listOfferings,
  listProviders,
  parseRef,
  quoteRate,
  showOffering,
} from "../../../src/catalog/price-book.js";
import { ValidationError } from "../../../src/core/errors.js";

const DAY = 86_400_000;
/** Midnight UTC, so a card checked on a given day has an exact age in days. */
const AT = new Date("2026-10-28T00:00:00Z");
const NO_SPEECH: PriceBookSources = { speech: [], media: [] };

function daysBefore(at: Date, days: number): string {
  return new Date(at.getTime() - days * DAY).toISOString().slice(0, 10);
}

function rate(over: Partial<RateView> = {}): RateView {
  return {
    id: "test/rate",
    provider: "testprov",
    model: "test-video-1",
    family: "test-video",
    task: "video",
    conditions: {},
    components: [{ unit: "video_second", amount: 0.1, per: 1 }],
    currency: "USD",
    billing: "api-payg",
    tier: "api",
    region: "global",
    last_checked: "2026-10-28",
    source: "https://example.test/pricing",
    freshness: "current",
    ...over,
  };
}

function card(over: Partial<MediaRateCard> = {}): MediaRateCard {
  return {
    id: "testprov/test-video-1@720p",
    provider: "testprov",
    family: "test-video",
    models: ["test-video-1"],
    task: "video",
    conditions: {},
    components: [{ unit: "video_second", amount: 0.1, per: 1 }],
    currency: "USD",
    billing: "api-payg",
    tier: "api",
    region: "global",
    last_checked: "2026-10-28",
    source: "https://example.test/pricing",
    verified: true,
    ...over,
  };
}

function mediaOnly(...cards: MediaRateCard[]): PriceBookSources {
  return { speech: [], media: cards };
}

describe("freshnessOf", () => {
  const checked = { verified: true, last_checked: "2026-10-28" };

  it("is current on the day it was checked", () => {
    expect(freshnessOf(checked, AT)).toBe("current");
  });

  it("stays current up to MAX_PRICE_AGE_DAYS (120) and turns stale after", () => {
    expect(freshnessOf({ verified: true, last_checked: daysBefore(AT, 120) }, AT)).toBe("current");
    expect(freshnessOf({ verified: true, last_checked: daysBefore(AT, 121) }, AT)).toBe("stale");
  });

  it("is unverified when the rate is kept for reference only", () => {
    expect(freshnessOf({ verified: false, last_checked: "2026-10-28" }, AT)).toBe("unverified");
  });

  it("is expired from its end instant onwards, and not_started before its start", () => {
    const window = { verified: true, last_checked: "2026-10-28" };
    expect(freshnessOf({ ...window, until: "2026-10-28T00:00:00Z" }, AT)).toBe("expired");
    expect(freshnessOf({ ...window, until: "2026-10-28T00:00:01Z" }, AT)).toBe("current");
    expect(freshnessOf({ ...window, from: "2026-10-28T00:00:01Z" }, AT)).toBe("not_started");
    expect(freshnessOf({ ...window, from: "2026-10-28T00:00:00Z" }, AT)).toBe("current");
  });
});

describe("allRates with custom sources", () => {
  it("builds speech rates from a price entry, keeping source, check date and window", () => {
    const speech: PriceEntry = {
      id: "fakeprov/fake-tts@paid",
      provider: "fakeprov",
      models: ["fake-tts-2"],
      tier: "paid",
      currency: "USD",
      region: "global",
      windows: [
        {
          until: "2026-11-01T00:00:00Z",
          label: "promotion",
          components: [{ meter: "characters", usd: 0.01, per: 1000 }],
        },
        {
          from: "2026-11-01T00:00:00Z",
          components: [{ meter: "characters", usd: 0.02, per: 1000 }],
        },
      ],
      last_checked: "2026-10-28",
      source: "https://example.test/tts-pricing",
      verified: true,
    };
    const [r] = allRates(AT, { speech: [speech], media: [] });
    expect(r).toMatchObject({
      id: "fakeprov/fake-tts@paid",
      provider: "fakeprov",
      model: "fake-tts-2",
      family: "fake-tts-2",
      task: "speech",
      currency: "USD",
      freshness: "current",
      source: "https://example.test/tts-pricing",
      last_checked: "2026-10-28",
      effective_until: "2026-11-01T00:00:00Z",
      label: "promotion",
      components: [{ unit: "characters", amount: 0.01, per: 1000 }],
    });
  });

  it("uses the window in force, then the next one to start, when the time is outside the first", () => {
    const speech: PriceEntry = {
      id: "fakeprov/fake-tts@paid",
      provider: "fakeprov",
      models: ["fake-tts-2"],
      tier: "paid",
      currency: "USD",
      region: "global",
      windows: [
        {
          until: "2026-11-01T00:00:00Z",
          components: [{ meter: "characters", usd: 0.01, per: 1000 }],
        },
        {
          from: "2026-11-01T00:00:00Z",
          components: [{ meter: "characters", usd: 0.02, per: 1000 }],
        },
      ],
      last_checked: "2026-10-28",
      source: "https://example.test/tts-pricing",
      verified: true,
    };
    const later = allRates(new Date("2026-11-02T00:00:00Z"), { speech: [speech], media: [] });
    expect(later[0]?.components[0]?.amount).toBe(0.02);
    expect(later[0]?.freshness).toBe("current");
  });

  it("marks an unverified media card unverified and never quotes it", () => {
    const [r] = allRates(AT, mediaOnly(card({ verified: false })));
    expect(r?.freshness).toBe("unverified");
    const q = quoteRate(r as RateView, { task: "video", duration_s: 10 });
    expect(q).toMatchObject({ status: "unknown", amount: null, currency: null });
  });
});

describe("quoteRate", () => {
  it("never quotes a rate that is not current: status unknown, amount null, not $0", () => {
    for (const freshness of ["stale", "unverified", "expired", "not_started"] as const) {
      const q = quoteRate(rate({ freshness }), { task: "video", duration_s: 10 });
      expect(q.status).toBe("unknown");
      expect(q.amount).toBeNull();
      expect(q.currency).toBeNull();
      expect(q.reason).toContain(freshness);
    }
  });

  it("reports a rate for another task as not_equivalent", () => {
    const q = quoteRate(rate({ task: "video" }), { task: "speech", duration_s: 10 });
    expect(q.status).toBe("not_equivalent");
    expect(q.amount).toBeNull();
    expect(q.reason).toBe("rate is for video");
  });

  it("reports a different resolution as not_equivalent with the rate's resolution", () => {
    const q = quoteRate(rate({ conditions: { resolution: "1080p", audio: "any" } }), {
      resolution: "720p",
      duration_s: 10,
    });
    expect(q).toMatchObject({ status: "not_equivalent", amount: null });
    expect(q.reason).toBe("rate is for resolution 1080p");
  });

  it("reports a resolution the rate does not state as unconfirmed, not cheaper", () => {
    const q = quoteRate(rate(), { resolution: "720p", duration_s: 10 });
    expect(q.status).toBe("not_equivalent");
    expect(q.amount).toBeNull();
    expect(q.unconfirmed).toEqual(["resolution"]);
  });

  it("reports audio asked for on a rate with no audio condition as unconfirmed", () => {
    const q = quoteRate(rate({ conditions: { resolution: "720p" } }), {
      resolution: "720p",
      audio: true,
      duration_s: 10,
    });
    expect(q.status).toBe("not_equivalent");
    expect(q.unconfirmed).toEqual(["audio"]);
    expect(q.amount).toBeNull();
  });

  it("treats audio: any as confirming either setting", () => {
    const base = { conditions: { resolution: "720p", audio: "any" as const } };
    expect(quoteRate(rate(base), { resolution: "720p", audio: true, duration_s: 10 }).status).toBe(
      "quoted",
    );
    expect(quoteRate(rate(base), { resolution: "720p", audio: false, duration_s: 10 }).status).toBe(
      "quoted",
    );
  });

  it("reports a fixed audio setting that contradicts the configuration as a mismatch", () => {
    const q = quoteRate(rate({ conditions: { resolution: "720p", audio: false } }), {
      resolution: "720p",
      audio: true,
      duration_s: 10,
    });
    expect(q.status).toBe("not_equivalent");
    expect(q.reason).toBe("rate is for audio off");
    expect(q.unconfirmed).toBeUndefined();
  });

  it("reports an aspect ratio the rate does not state as unconfirmed, and a different one as a mismatch", () => {
    const unstated = quoteRate(rate({ conditions: { resolution: "720p" } }), {
      resolution: "720p",
      aspect_ratio: "16:9",
      duration_s: 10,
    });
    expect(unstated.unconfirmed).toEqual(["aspect ratio"]);
    const other = quoteRate(rate({ conditions: { resolution: "720p", aspect_ratio: "9:16" } }), {
      resolution: "720p",
      aspect_ratio: "16:9",
      duration_s: 10,
    });
    expect(other.status).toBe("not_equivalent");
    expect(other.reason).toBe("rate is for aspect ratio 9:16");
  });

  it("refuses a duration outside the rate's range, on either side", () => {
    const ranged = rate({
      conditions: { resolution: "720p", audio: "any", min_duration_s: 4, max_duration_s: 10 },
    });
    expect(quoteRate(ranged, { resolution: "720p", duration_s: 2 }).reason).toBe(
      "rate is for duration from 4s",
    );
    expect(quoteRate(ranged, { resolution: "720p", duration_s: 12 }).reason).toBe(
      "rate is for duration up to 10s",
    );
    expect(quoteRate(ranged, { resolution: "720p", duration_s: 10 }).status).toBe("quoted");
  });

  it("prices a video_second rate only with a duration: without one it is unit_only, not $0", () => {
    const q = quoteRate(rate({ conditions: { resolution: "720p", audio: "any" } }), {
      resolution: "720p",
    });
    expect(q).toMatchObject({ status: "unit_only", amount: null, currency: "USD" });
    expect(q.reason).toBe("give --duration to price a clip");
    expect(q.basis).toBe("0.1 USD/video_second");
  });

  it("multiplies a video_second rate by the duration, rounded to 6 decimals", () => {
    const q = quoteRate(
      rate({
        conditions: { resolution: "720p", audio: "any" },
        components: [{ unit: "video_second", amount: 0.3034, per: 1 }],
      }),
      { resolution: "720p", duration_s: 10 },
    );
    expect(q).toMatchObject({
      status: "quoted",
      amount: 3.034,
      currency: "USD",
      basis: "10 s x 0.3034 USD/video_second",
    });
  });

  it("applies billed_min_duration_s to a short clip", () => {
    const short = rate({
      conditions: { billed_min_duration_s: 5 },
      components: [{ unit: "video_second", amount: 0.1, per: 1 }],
    });
    expect(quoteRate(short, { duration_s: 2 })).toMatchObject({
      status: "quoted",
      amount: 0.5,
      basis: "5 s x 0.1 USD/video_second",
    });
    expect(quoteRate(short, { duration_s: 8 })).toMatchObject({ status: "quoted", amount: 0.8 });
  });

  it("prices a per-video rate as one video whatever the duration", () => {
    const q = quoteRate(rate({ components: [{ unit: "video", amount: 0.5, per: 1 }] }), {
      duration_s: 30,
    });
    expect(q).toMatchObject({ status: "quoted", amount: 0.5, basis: "1 x 0.5 USD/video" });
  });

  it("prices per-image rates by the requested count, defaulting to one", () => {
    const img = rate({ task: "image", components: [{ unit: "image", amount: 0.04, per: 1 }] });
    expect(quoteRate(img, { count: 4 })).toMatchObject({ status: "quoted", amount: 0.16 });
    expect(quoteRate(img, {})).toMatchObject({ status: "quoted", amount: 0.04 });
  });

  it("leaves token-metered rates as unit_only, since tokens are measured at run time", () => {
    const q = quoteRate(
      rate({ components: [{ unit: "output_video_tokens", amount: 7, per: 1_000_000 }] }),
      { duration_s: 10 },
    );
    expect(q).toMatchObject({ status: "unit_only", amount: null });
    expect(q.reason).toBe("billed per output_video_tokens, measured at run time");
  });

  it("leaves a rate billed on several meters as unit_only", () => {
    const q = quoteRate(
      rate({
        components: [
          { unit: "input_text_tokens", amount: 1, per: 1_000_000 },
          { unit: "output_video_tokens", amount: 7, per: 1_000_000 },
        ],
      }),
      { duration_s: 10 },
    );
    expect(q.status).toBe("unit_only");
    expect(q.reason).toBe("billed on several meters measured at run time");
  });

  it("lists the open conditions the rate is stated for as assumed", () => {
    const q = quoteRate(
      rate({
        conditions: { resolution: "720p", aspect_ratio: "16:9", audio: true },
        components: [{ unit: "video_second", amount: 0.1, per: 1 }],
      }),
      { duration_s: 10, resolution: "720p", aspect_ratio: "16:9", audio: true },
    );
    expect(q.assumed).toBeUndefined();
    // Conditions the configuration leaves out are taken as the rate states them, and listed.
    const open = quoteRate(
      rate({ conditions: { resolution: "720p", aspect_ratio: "16:9", audio: true } }),
      { duration_s: 10, resolution: "720p" },
    );
    expect(open).toMatchObject({
      status: "quoted",
      amount: 1,
      assumed: ["aspect ratio 16:9", "audio on"],
    });
    const named = quoteRate(
      rate({ conditions: { resolution: "720p", aspect_ratio: "16:9", audio: true } }),
      { duration_s: 10, resolution: "720p", aspect_ratio: "16:9" },
    );
    expect(named).toMatchObject({ status: "quoted", assumed: ["audio on"] });
  });

  it("names the stated resolution and aspect ratio as assumed when the config leaves them out", () => {
    const q = quoteRate(
      rate({ conditions: { resolution: "720p", aspect_ratio: "16:9", audio: false } }),
      { duration_s: 10 },
    );
    expect(q).toMatchObject({
      status: "quoted",
      assumed: ["resolution 720p", "aspect ratio 16:9", "audio off"],
    });
  });
});

describe("betterQuote", () => {
  const base = { ref: "p:m", provider: "p", model: "m", amount: null, currency: null } as const;
  const quoted = (amount: number): Quote => ({
    ...base,
    status: "quoted",
    amount,
    currency: "USD",
  });
  const unitOnly: Quote = { ...base, status: "unit_only" };
  const mismatch: Quote = { ...base, status: "not_equivalent", reason: "rate is for video" };
  const unconfirmed: Quote = { ...base, status: "not_equivalent", unconfirmed: ["audio"] };

  it("prefers the more usable status", () => {
    expect(betterQuote(quoted(9), unitOnly)).toBe(true);
    expect(betterQuote(unitOnly, quoted(9))).toBe(false);
    expect(betterQuote(unitOnly, mismatch)).toBe(true);
  });

  it("prefers the lower amount between two quotes", () => {
    expect(betterQuote(quoted(1), quoted(2))).toBe(true);
    expect(betterQuote(quoted(2), quoted(1))).toBe(false);
  });

  it("prefers a non-equivalent quote that only lacks confirmation over one that contradicts the config", () => {
    expect(betterQuote(unconfirmed, mismatch)).toBe(true);
    expect(betterQuote(mismatch, unconfirmed)).toBe(false);
  });
});

describe("compareFamily", () => {
  it("ranks seedance-2.0 at 720p for 10 s: BytePlus $1.50, then two fal endpoints at $3.034", () => {
    const c = compareFamily("seedance-2.0", { resolution: "720p", duration_s: 10 }, AT);
    expect(c.family).toBe("seedance-2.0");
    expect(c.comparable.map((q) => [q.ref, q.amount, q.currency, q.rank])).toEqual([
      ["byteplus:dreamina-seedance-2-0-260128", 1.5, "USD", 1],
      ["fal:bytedance/seedance-2.0/image-to-video", 3.034, "USD", 2],
      ["fal:bytedance/seedance-2.0/text-to-video", 3.034, "USD", 3],
    ]);
    expect(c.comparable[0]?.assumed).toEqual(["aspect ratio 16:9"]);
    expect(c.note).toContain("List prices only");
  });

  it("never includes the fast variant in the plain family", () => {
    const c = compareFamily("seedance-2.0", { resolution: "720p", duration_s: 10 }, AT);
    const refs = [...c.comparable, ...c.not_comparable].map((q) => q.ref);
    expect(refs.some((ref) => ref.includes("fast"))).toBe(false);
  });

  it("matches the exact family only: seedance-2.0-fast is its own family", () => {
    const fast = compareFamily("seedance-2.0-fast", { resolution: "720p", duration_s: 10 }, AT);
    expect(fast.comparable.map((q) => q.ref)).toEqual(
      expect.arrayContaining(["byteplus:dreamina-seedance-2-0-fast-260128"]),
    );
    expect(fast.comparable.every((q) => q.ref.includes("fast"))).toBe(true);
    expect(fast.comparable[0]).toMatchObject({
      ref: "byteplus:dreamina-seedance-2-0-fast-260128",
      amount: 1.2,
      rank: 1,
    });
  });

  it("lists a clip with no duration as not comparable (unit_only), never as $0", () => {
    const c = compareFamily("seedance-2.0", { resolution: "720p" }, AT);
    expect(c.comparable).toEqual([]);
    expect(c.not_comparable.length).toBeGreaterThan(0);
    expect(c.not_comparable.every((q) => q.status === "unit_only" && q.amount === null)).toBe(true);
  });

  it("puts a family's stale prices in not_comparable with status unknown, not in the ranking", () => {
    const later = new Date("2027-03-01T00:00:00Z");
    const c = compareFamily("seedance-2.0", { resolution: "720p", duration_s: 10 }, later);
    expect(c.comparable).toEqual([]);
    expect(c.not_comparable.length).toBeGreaterThan(0);
    expect(c.not_comparable.every((q) => q.status === "unknown")).toBe(true);
    expect(c.not_comparable.some((q) => q.reason?.startsWith("rate is stale"))).toBe(true);
  });

  it("ranks cards from custom sources by amount, ties broken by ref", () => {
    const sources = mediaOnly(
      card({
        id: "b",
        provider: "bprov",
        models: ["m"],
        family: "fam",
        conditions: { resolution: "720p", audio: "any" },
        components: [{ unit: "video_second", amount: 0.2, per: 1 }],
      }),
      card({
        id: "a",
        provider: "aprov",
        models: ["m"],
        family: "fam",
        conditions: { resolution: "720p", audio: "any" },
        components: [{ unit: "video_second", amount: 0.2, per: 1 }],
      }),
      card({
        id: "c",
        provider: "cprov",
        models: ["m"],
        family: "fam",
        conditions: { resolution: "720p", audio: "any" },
        components: [{ unit: "video_second", amount: 0.1, per: 1 }],
      }),
    );
    const c = compareFamily("fam", { resolution: "720p", duration_s: 10 }, AT, sources);
    expect(c.comparable.map((q) => `${q.ref}:${q.rank}`)).toEqual([
      "cprov:m:1",
      "aprov:m:2",
      "bprov:m:3",
    ]);
  });

  it("reports offerings of the family that have no rate on file as unpriced", () => {
    const sources: PriceBookSources = { speech: [], media: [] };
    const c = compareFamily("eleven-v4", { duration_s: 10 }, AT, sources);
    expect(c.unpriced).toContain("fal:elevenlabs/tts/eleven-v4");
    expect(c.comparable).toEqual([]);
  });
});

describe("familyOf", () => {
  it("strips the vendor prefix and a -YYYYMMDD date suffix, lower-cased", () => {
    expect(familyOf("bytedance/seedance-2.0")).toBe("seedance-2.0");
    expect(familyOf("Vendor/Model-20260714")).toBe("model");
    expect(familyOf("elevenlabs/tts/eleven-v4")).toBe("eleven-v4");
  });

  it("keeps a suffix that is not a -20YYMMDD date", () => {
    expect(familyOf("voxtral-mini-tts-2603")).toBe("voxtral-mini-tts-2603");
    expect(familyOf("model-2026101")).toBe("model-2026101");
    expect(familyOf("model-19990101")).toBe("model-19990101");
  });
});

describe("listOfferings", () => {
  it("keeps verified offerings without a rate as price_status unknown with zero rates", () => {
    const list = listOfferings(AT);
    const o = list.find((x) => x.ref === "fal:elevenlabs/tts/eleven-v4");
    expect(o).toMatchObject({ verified: true, price_status: "unknown", rates: 0 });
  });

  it("reports an offering with only a stale rate as stale and an unverified one as unverified", () => {
    const sources = mediaOnly(
      card({
        id: "s",
        provider: "sprov",
        models: ["stale-model"],
        last_checked: daysBefore(AT, 200),
      }),
      card({ id: "u", provider: "uprov", models: ["unv-model"], verified: false }),
    );
    const list = listOfferings(AT, sources);
    expect(list.find((o) => o.ref === "sprov:stale-model")).toMatchObject({
      price_status: "stale",
      verified: false,
      rates: 1,
    });
    expect(list.find((o) => o.ref === "uprov:unv-model")).toMatchObject({
      price_status: "unverified",
      rates: 1,
    });
  });

  it("reports an offering whose only rate has expired as unknown, not unverified", () => {
    const sources = mediaOnly(
      card({
        id: "x",
        provider: "xprov",
        models: ["expired-model"],
        until: "2026-10-01T00:00:00Z",
        last_checked: "2026-09-01",
      }),
    );
    expect(listOfferings(AT, sources).find((o) => o.ref === "xprov:expired-model")).toMatchObject({
      price_status: "unknown",
      rates: 1,
    });
  });

  it("reports an offering with one current and one stale rate as priced", () => {
    const sources = mediaOnly(
      card({ id: "old", provider: "mixprov", models: ["m"], last_checked: daysBefore(AT, 200) }),
      card({ id: "new", provider: "mixprov", models: ["m"] }),
    );
    expect(listOfferings(AT, sources).find((o) => o.ref === "mixprov:m")).toMatchObject({
      price_status: "priced",
      rates: 2,
      command: null,
    });
  });

  it("uses the card's command for a rate-only offering", () => {
    const list = listOfferings(
      AT,
      mediaOnly(
        card({ provider: "cmdprov", models: ["m"], task: "video", command: "cmdprov video" }),
      ),
    );
    expect(list.find((o) => o.ref === "cmdprov:m")).toMatchObject({
      verified: false,
      tasks: ["video"],
      command: "cmdprov video",
    });
  });

  it("sorts offerings by ref", () => {
    const refs = listOfferings(AT).map((o) => o.ref);
    expect([...refs].sort((a, b) => a.localeCompare(b))).toEqual(refs);
  });
});

describe("filterOfferings", () => {
  const list: OfferingView[] = [
    {
      ref: "fal:a",
      provider: "fal",
      model: "a",
      family: "seedance-2.0",
      tasks: ["video"],
      verified: true,
      command: null,
      price_status: "priced",
      rates: 1,
    },
    {
      ref: "fal:a-fast",
      provider: "fal",
      model: "a-fast",
      family: "seedance-2.0-fast",
      tasks: ["video"],
      verified: false,
      command: null,
      price_status: "unknown",
      rates: 0,
    },
    {
      ref: "byteplus:b",
      provider: "byteplus",
      model: "b",
      family: "seedance-2.0",
      tasks: ["image-to-video"],
      verified: true,
      command: null,
      price_status: "stale",
      rates: 1,
    },
  ];

  it("filters by provider, task and verified/priced flags together", () => {
    expect(filterOfferings(list, { provider: "fal", task: "video" }).map((o) => o.ref)).toEqual([
      "fal:a",
      "fal:a-fast",
    ]);
    expect(filterOfferings(list, { priced: true }).map((o) => o.ref)).toEqual(["fal:a"]);
    expect(filterOfferings(list, { verified: true }).map((o) => o.ref)).toEqual([
      "fal:a",
      "byteplus:b",
    ]);
  });

  it("matches a family and its variants by prefix", () => {
    expect(filterOfferings(list, { family: "Seedance-2.0" }).map((o) => o.ref)).toEqual([
      "fal:a",
      "fal:a-fast",
      "byteplus:b",
    ]);
    expect(filterOfferings(list, { family: "seedance-2.0-fast" }).map((o) => o.ref)).toEqual([
      "fal:a-fast",
    ]);
  });
});

describe("parseRef", () => {
  it("splits at the first colon; the model may contain colons and slashes", () => {
    expect(parseRef("fal:bytedance/seedance-2.0/text-to-video")).toEqual({
      provider: "fal",
      model: "bytedance/seedance-2.0/text-to-video",
    });
    expect(parseRef("p:a:b")).toEqual({ provider: "p", model: "a:b" });
  });

  it("trims whitespace around both parts", () => {
    expect(parseRef(" fal : m ")).toEqual({ provider: "fal", model: "m" });
  });

  it("returns undefined without a provider, without a model, or without a colon", () => {
    expect(parseRef(":model")).toBeUndefined();
    expect(parseRef("fal:")).toBeUndefined();
    expect(parseRef("fal")).toBeUndefined();
  });
});

describe("showOffering", () => {
  it("returns undefined for an unknown or malformed ref", () => {
    expect(showOffering("fal:no-such/model", AT)).toBeUndefined();
    expect(showOffering("not-a-ref", AT)).toBeUndefined();
  });

  it("returns the offering with its rates and provider identity", () => {
    const d = showOffering("fal:bytedance/seedance-2.0/text-to-video", AT);
    expect(d?.offering).toMatchObject({
      ref: "fal:bytedance/seedance-2.0/text-to-video",
      provider: "fal",
      price_status: "priced",
    });
    // One rate per resolution the endpoint is priced at (720p and 1080p).
    expect(d?.rates.map((r) => r.conditions.resolution)).toEqual(["720p", "1080p"]);
    expect(
      d?.rates.every(
        (r) => r.model === "bytedance/seedance-2.0/text-to-video" && r.freshness === "current",
      ),
    ).toBe(true);
    expect(d?.provider.name).toBe("fal.ai");
  });
});

describe("listProviders", () => {
  it("reports key readiness from the hooks and never includes key values", () => {
    const providers = listProviders(
      { keys: (g) => (g === "fal" ? ["FAL_KEY"] : []), ready: (g) => (g === "fal" ? true : null) },
      AT,
    );
    const fal = providers.find((p) => p.provider === "fal");
    expect(fal).toMatchObject({ ready: true, keys: ["FAL_KEY"], name: "fal.ai" });
    expect(fal?.commands.every((c) => c.startsWith("fal "))).toBe(true);
    expect(fal?.priced_offerings).toBeGreaterThan(0);
    expect(providers.find((p) => p.provider === "openai")?.ready).toBeNull();
    expect(JSON.stringify(providers)).not.toMatch(/sk-|AIza/);
  });
});

describe("price book at the real data", () => {
  it("shows the BytePlus and fal Seedance 2.0 rates with their sources", () => {
    const detail = showOffering("byteplus:dreamina-seedance-2-0-260128", AT);
    expect(detail?.offering.price_status).toBe("priced");
    expect(detail?.rates.every((r) => r.source.startsWith("https://"))).toBe(true);
    expect(detail?.rates.every((r) => r.last_checked === "2026-10-28")).toBe(true);
  });

  it("keeps the BytePlus seedance-2.0 alias unpriced, as its note says", () => {
    expect(listOfferings(AT).find((o) => o.ref === "byteplus:seedance-2.0")).toBeUndefined();
  });
});

describe("price-book-view", () => {
  it("lists the four views", () => {
    expect(PRICE_BOOK_VIEWS).toEqual(["providers", "models", "show", "compare"]);
  });

  it("refuses show without a ref and compare without a family", () => {
    expect(() =>
      priceBookPayload({ view: "show" }, { keys: () => [], ready: () => null }, AT),
    ).toThrow(ValidationError);
    expect(() =>
      priceBookPayload({ view: "compare" }, { keys: () => [], ready: () => null }, AT),
    ).toThrow(ValidationError);
  });

  it("returns the comparison for a family with the same config as the CLI", () => {
    const payload = priceBookPayload(
      { view: "compare", family: "seedance-2.0", resolution: "720p", duration: "10" },
      { keys: () => [], ready: () => null },
      AT,
    );
    expect(payload.view).toBe("compare");
    if (payload.view === "compare") {
      expect(payload.comparison.comparable[0]?.amount).toBe(1.5);
      expect(payload.comparison.config).toEqual({ resolution: "720p", duration_s: 10 });
    }
  });

  it("adds quotes to show only when a configuration is given", () => {
    const plain = offeringWithQuotes("fal:bytedance/seedance-2.0/text-to-video", {}, AT);
    expect(plain.quotes).toBeUndefined();
    expect(plain.config).toBeUndefined();
    const quoted = offeringWithQuotes(
      "fal:bytedance/seedance-2.0/text-to-video",
      { resolution: "720p", duration: "10" },
      AT,
    );
    expect(quoted.quotes?.[0]).toMatchObject({ status: "quoted", amount: 3.034 });
  });

  it("refuses show for a ref that is not in the catalogue", () => {
    expect(() => offeringWithQuotes("fal:nope/nope", {}, AT)).toThrow(/not in the catalogue/);
  });

  it("filters the models view by task and priced", () => {
    const payload = priceBookPayload(
      { view: "models", task: "video", priced: true },
      { keys: () => [], ready: () => null },
      AT,
    );
    if (payload.view !== "models") throw new Error("expected models view");
    expect(payload.offerings.length).toBeGreaterThan(0);
    expect(
      payload.offerings.every((o) => o.price_status === "priced" && o.tasks.includes("video")),
    ).toBe(true);
  });
});
