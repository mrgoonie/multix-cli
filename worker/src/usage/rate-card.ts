/**
 * The account's own price list, used to estimate the cost of runs whose
 * provider reported none. Nothing here is a provider bill: estimates are
 * stored with provenance `estimated`, the rate card version and the date the
 * price applies from. A run with no applicable price stays unknown (null).
 */

import { type SqlPort, type SqlRow, v } from "./sql-port.js";
import { RATE_UNITS, type RateCardEntry, type RateUnit } from "./usage-types.js";

export const MAX_RATE_ENTRIES = 200;
const NAME_RE = /^[A-Za-z0-9._:/*-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What a run used, as far as it is known; null quantities cannot be priced. */
export interface RunQuantities {
  outputs: number | null;
  outputSeconds: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  credits: number | null;
}

export interface Estimate {
  usd: number;
  source: "account_rate_card";
  version: string;
  effectiveFrom: string;
}

interface RateRow extends SqlRow {
  provider: string;
  model: string;
  unit: string;
  usd: number;
  effective_from: string;
  version: string;
}

export class RateCardError extends Error {}

/** Validate a whole replacement rate card; throws RateCardError with a caller-safe message. */
export function parseRateCard(input: unknown): RateCardEntry[] {
  if (!Array.isArray(input)) throw new RateCardError("entries must be an array");
  if (input.length > MAX_RATE_ENTRIES) {
    throw new RateCardError(`at most ${MAX_RATE_ENTRIES} entries`);
  }
  return input.map((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const at = `entries[${i}]`;
    if (typeof e.provider !== "string" || !NAME_RE.test(e.provider)) {
      throw new RateCardError(`${at}.provider must be a provider group such as gemini`);
    }
    const model = e.model === undefined ? "*" : e.model;
    if (typeof model !== "string" || !NAME_RE.test(model)) {
      throw new RateCardError(`${at}.model must be a model id or *`);
    }
    if (!RATE_UNITS.includes(e.unit as RateUnit)) {
      throw new RateCardError(`${at}.unit must be one of ${RATE_UNITS.join(", ")}`);
    }
    if (typeof e.usd !== "number" || !Number.isFinite(e.usd) || e.usd < 0 || e.usd > 10_000) {
      throw new RateCardError(`${at}.usd must be a number from 0 to 10000`);
    }
    const effectiveFrom = e.effective_from ?? e.effectiveFrom;
    if (
      typeof effectiveFrom !== "string" ||
      !DATE_RE.test(effectiveFrom) ||
      Number.isNaN(Date.parse(effectiveFrom))
    ) {
      throw new RateCardError(`${at}.effective_from must be a date such as 2026-10-01`);
    }
    const version = e.version ?? "";
    if (typeof version !== "string" || version.length > 64) {
      throw new RateCardError(`${at}.version must be at most 64 characters`);
    }
    return {
      provider: e.provider,
      model,
      unit: e.unit as RateUnit,
      usd: e.usd,
      effectiveFrom,
      version: version || effectiveFrom,
    };
  });
}

function quantity(unit: RateUnit, q: RunQuantities): number | null {
  switch (unit) {
    case "job":
      return 1;
    case "output":
      return q.outputs;
    case "output_second":
      return q.outputSeconds;
    case "1k_input_tokens":
      return q.tokensInput === null ? null : q.tokensInput / 1000;
    case "1k_output_tokens":
      return q.tokensOutput === null ? null : q.tokensOutput / 1000;
    case "credit":
      return q.credits;
  }
}

export class RateCard {
  constructor(private readonly sql: SqlPort) {}

  list(): RateCardEntry[] {
    return this.sql
      .exec<RateRow>("SELECT * FROM rate_card ORDER BY provider, model, unit, effective_from")
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        unit: r.unit as RateUnit,
        usd: r.usd,
        effectiveFrom: r.effective_from,
        version: r.version,
      }));
  }

  /** Replace the whole card (call inside a transaction). */
  replace(entries: RateCardEntry[]): void {
    this.sql.exec("DELETE FROM rate_card");
    for (const e of entries) {
      this.sql.exec(
        "INSERT OR REPLACE INTO rate_card (provider, model, unit, usd, effective_from, version) VALUES (?, ?, ?, ?, ?, ?)",
        e.provider,
        e.model,
        e.unit,
        e.usd,
        e.effectiveFrom,
        e.version,
      );
    }
  }

  /**
   * Prices in force at `at` for the provider and model: per unit, the exact
   * model wins over `*`, and the latest `effective_from` on or before `at`.
   */
  private applicable(provider: string, model: string | null, at: number): RateRow[] {
    const day = new Date(at).toISOString().slice(0, 10);
    const rows = this.sql.exec<RateRow>(
      "SELECT * FROM rate_card WHERE provider = ? AND (model = ? OR model = '*') AND effective_from <= ? ORDER BY effective_from DESC",
      provider,
      v(model ?? "*"),
      day,
    );
    const byUnit = new Map<string, RateRow>();
    for (const row of rows) {
      const current = byUnit.get(row.unit);
      const better =
        !current ||
        (current.model === "*" && row.model !== "*") ||
        (current.model === row.model && row.effective_from > current.effective_from);
      if (better) byUnit.set(row.unit, row);
    }
    return [...byUnit.values()];
  }

  /** Sum of every applicable price whose quantity is known; null when none applies. */
  estimate(provider: string, model: string | null, at: number, q: RunQuantities): Estimate | null {
    let usd = 0;
    let used: RateRow | undefined;
    for (const row of this.applicable(provider, model, at)) {
      const n = quantity(row.unit as RateUnit, q);
      if (n === null) continue;
      usd += row.usd * n;
      if (!used || row.effective_from > used.effective_from) used = row;
    }
    if (!used) return null;
    return {
      usd: Math.round(usd * 1e6) / 1e6,
      source: "account_rate_card",
      version: used.version,
      effectiveFrom: used.effective_from,
    };
  }

  /** Price of one job known before it runs (unit `job` only), for budget reservations. */
  jobPrice(provider: string, model: string | null, at: number): number | null {
    const row = this.applicable(provider, model, at).find((r) => r.unit === "job");
    return row ? row.usd : null;
  }
}
