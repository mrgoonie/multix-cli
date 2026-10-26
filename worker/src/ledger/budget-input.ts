/**
 * Validation of a budget as submitted to the REST API or the dashboard: one
 * parser so both surfaces accept the same budgets. Error messages name the
 * field and the rule, never the submitted value.
 */

import { FILTER_VALUE, LedgerQueryError } from "./ledger-query.js";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPE_KINDS,
  type BudgetInput,
  type BudgetPeriod,
  type BudgetScopeKind,
} from "./ledger-types.js";

export const MAX_BUDGET_NAME_CHARS = 80;
export const MAX_BUDGET_LIMIT_USD = 10_000_000;
export const DEFAULT_BUDGET_THRESHOLDS: readonly number[] = [50, 80, 100];
export const MAX_BUDGET_THRESHOLDS = 5;
export const MAX_BUDGET_THRESHOLD = 1000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new LedgerQueryError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_BUDGET_NAME_CHARS || CONTROL.test(name)) {
    throw new LedgerQueryError(
      `name must be 1-${MAX_BUDGET_NAME_CHARS} characters without control characters`,
    );
  }
  return name;
}

function parseScopeValue(kind: BudgetScopeKind, value: unknown): string | null {
  if (kind === "account") return null;
  if (typeof value !== "string" || !FILTER_VALUE.test(value)) {
    throw new LedgerQueryError(
      "scope_value is required for this scope_kind: 1-200 letters, digits, spaces or _ . : @ / + -, starting with a letter or digit",
    );
  }
  return value;
}

function parseLimitUsd(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_BUDGET_LIMIT_USD
  ) {
    throw new LedgerQueryError(
      `limit_usd must be a number greater than 0 and at most ${MAX_BUDGET_LIMIT_USD}`,
    );
  }
  return value;
}

function parseThresholds(value: unknown): number[] {
  if (value === undefined || value === null) return [...DEFAULT_BUDGET_THRESHOLDS];
  const problem = `thresholds must be 1-${MAX_BUDGET_THRESHOLDS} unique integer percentages between 1 and ${MAX_BUDGET_THRESHOLD}`;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BUDGET_THRESHOLDS) {
    throw new LedgerQueryError(problem);
  }
  for (const t of value) {
    if (!Number.isInteger(t) || t < 1 || t > MAX_BUDGET_THRESHOLD) {
      throw new LedgerQueryError(problem);
    }
  }
  const unique = [...new Set(value as number[])];
  if (unique.length !== value.length) throw new LedgerQueryError(problem);
  return unique.sort((a, b) => a - b);
}

/**
 * A complete budget: `name`, `scope_kind`, `scope_value` (ignored and stored
 * as null for the account scope), `period`, `limit_usd` and optional
 * `thresholds` (default [50, 80, 100], stored sorted). Throws LedgerQueryError.
 */
export function parseBudgetInput(body: Record<string, unknown>): BudgetInput {
  const name = parseName(body.name);
  const scopeKind = oneOf<BudgetScopeKind>(body.scope_kind, "scope_kind", BUDGET_SCOPE_KINDS);
  return {
    name,
    scope_kind: scopeKind,
    scope_value: parseScopeValue(scopeKind, body.scope_value),
    period: oneOf<BudgetPeriod>(body.period, "period", BUDGET_PERIODS),
    limit_usd: parseLimitUsd(body.limit_usd),
    thresholds: parseThresholds(body.thresholds),
  };
}
