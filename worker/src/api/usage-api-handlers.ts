/**
 * REST handlers for the account's usage ledger: summaries, events and
 * adjustments, export, CLI history import, deletion, budgets, the activity
 * log, the rate card and provider balances. Each call goes to the calling
 * account's own AccountUsage Durable Object, so no request can name another
 * account. The ledger records its own activities (imports, exports,
 * adjustments, deletions, budget, rate-card and balance changes).
 */

import type { AppContext, AppDeps } from "../app-context.js";
import { usageLedgerFor } from "../app-context.js";
import { SECURITY_HEADERS, json } from "../http-responses.js";
import { PROJECT_RE } from "../jobs/job-runner.js";
import type { AccountUsageStub } from "../usage/account-usage.js";
import { MAX_ACTIVITY_PAGE } from "../usage/activity-log.js";
import { fetchProviderBalances } from "../usage/provider-balances.js";
import { FilterError, MAX_EVENT_PAGE, parseUsageFilter, toCsv } from "../usage/usage-queries.js";
import type { Result } from "../usage/usage-service.js";
import type { UsageFilter } from "../usage/usage-types.js";
import type { ApiCaller } from "./account-api-handlers.js";
import { ApiError, readJsonObject } from "./api-http.js";

/**
 * Import bodies carry up to MAX_IMPORT_ENTRIES (500) CLI history entries, one
 * `multix history sync` batch, which does not fit the 64 KiB default.
 */
export const MAX_IMPORT_BODY_BYTES = 1024 * 1024;

const KIND_RE = /^[a-z0-9_.]{1,64}$/;
const MAX_TZ_OFFSET = 840;
export const DELETE_CONFIRMATION = "delete-all-usage";

export function usageLedger(app: AppContext, deps: AppDeps, userId: string): AccountUsageStub {
  const usage = usageLedgerFor(app.env, deps, userId);
  if (!usage)
    throw new ApiError(503, "unavailable", "Usage tracking is not available on this server");
  return usage;
}

const actorOf = (caller: ApiCaller) => `api_key:${caller.keyId}`;

function badRequest(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) badRequest(result.error);
  return result.value;
}

function filterFrom(url: URL): UsageFilter {
  try {
    return parseUsageFilter(url.searchParams, Date.now());
  } catch (error) {
    if (error instanceof FilterError) badRequest(error.message);
    throw error;
  }
}

/** An optional integer query parameter within [min, max]. */
function intParam(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^-?\d{1,16}$/.test(raw)) badRequest(`${name} must be an integer from ${min} to ${max}`);
  const n = Number(raw);
  if (n < min || n > max) badRequest(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** An optional date (ISO) or epoch-milliseconds query parameter. */
function timeParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = /^\d{1,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) badRequest(`${name} must be a date or epoch milliseconds`);
  return n;
}

export async function getUsageSummary(usage: AccountUsageStub, url: URL): Promise<Response> {
  const filter = filterFrom(url);
  const tz = intParam(url, "tz", -MAX_TZ_OFFSET, MAX_TZ_OFFSET) ?? 0;
  return json(200, await usage.summary(filter, tz));
}

export async function listUsageEvents(usage: AccountUsageStub, url: URL): Promise<Response> {
  const filter = filterFrom(url);
  const cursor = url.searchParams.get("cursor") || null;
  if (cursor !== null && cursor.length > 200) badRequest("cursor is not valid");
  const limit = intParam(url, "limit", 1, MAX_EVENT_PAGE);
  return json(200, unwrap(await usage.events(filter, cursor, limit)));
}

export async function getUsageEvent(usage: AccountUsageStub, id: string): Promise<Response> {
  const detail = await usage.event(id);
  if (!detail) throw new ApiError(404, "not_found", "Usage event not found");
  return json(200, detail);
}

/** POST /usage/events/{id}/adjustments: `{ kind, amountUsd, reason }`. */
export async function postAdjustment(
  usage: AccountUsageStub,
  caller: ApiCaller,
  id: string,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const adjustment = unwrap(await usage.adjust(id, body, actorOf(caller)));
  if (!adjustment) throw new ApiError(404, "not_found", "Usage event not found");
  return json(201, adjustment);
}

/** GET /usage/export: CSV (default) or JSON, newest first, capped at MAX_EXPORT_ROWS. */
export async function exportUsage(
  usage: AccountUsageStub,
  caller: ApiCaller,
  url: URL,
): Promise<Response> {
  const format = url.searchParams.get("format") || "csv";
  if (format !== "csv" && format !== "json") badRequest("format must be csv or json");
  const filter = filterFrom(url);
  const result = await usage.exportEvents(filter, actorOf(caller), format);
  const truncated: Record<string, string> = result.truncated
    ? { "x-multix-truncated": "true" }
    : {};
  if (format === "json") return json(200, result, truncated);
  return new Response(toCsv(result.items), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="multix-usage.csv"',
      ...SECURITY_HEADERS,
      ...truncated,
    },
  });
}

/** POST /usage/import: `{ entries: CliImportEntry[], project? }` from `multix history sync`. */
export async function importUsage(
  usage: AccountUsageStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request, MAX_IMPORT_BODY_BYTES);
  if (!Array.isArray(body.entries)) badRequest("entries must be an array");
  const project = body.project;
  if (project !== undefined && (typeof project !== "string" || !PROJECT_RE.test(project))) {
    badRequest("project must be 1-64 letters, digits, '.', '_' or '-'");
  }
  const result = unwrap(await usage.importCli(body.entries, project, actorOf(caller)));
  return json(200, {
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.rejected,
  });
}

/** DELETE /usage?confirm=delete-all-usage: every usage record; budgets and activities stay. */
export async function deleteUsage(
  usage: AccountUsageStub,
  caller: ApiCaller,
  url: URL,
): Promise<Response> {
  if (url.searchParams.get("confirm") !== DELETE_CONFIRMATION) {
    badRequest(`Add ?confirm=${DELETE_CONFIRMATION} to delete every usage record`);
  }
  return json(200, { deleted: await usage.deleteUsage(actorOf(caller)) });
}

export async function listBudgets(usage: AccountUsageStub): Promise<Response> {
  return json(200, { budgets: await usage.budgets() });
}

export async function createBudget(
  usage: AccountUsageStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  return json(201, unwrap(await usage.createBudget(body, actorOf(caller))));
}

export async function updateBudget(
  usage: AccountUsageStub,
  caller: ApiCaller,
  id: string,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const budget = unwrap(await usage.updateBudget(id, body, actorOf(caller)));
  if (!budget) throw new ApiError(404, "not_found", "Budget not found");
  return json(200, budget);
}

export async function deleteBudget(
  usage: AccountUsageStub,
  caller: ApiCaller,
  id: string,
): Promise<Response> {
  if (!(await usage.deleteBudget(id, actorOf(caller)))) {
    throw new ApiError(404, "not_found", "Budget not found");
  }
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

/** GET /activities?kind&q&from&to&before&limit, newest first. */
export async function listActivities(usage: AccountUsageStub, url: URL): Promise<Response> {
  const kind = url.searchParams.get("kind") || undefined;
  if (kind !== undefined && !KIND_RE.test(kind)) {
    badRequest("kind must be an activity kind such as budget.created, or a prefix such as budget.");
  }
  const q = url.searchParams.get("q")?.slice(0, 100) || undefined;
  return json(
    200,
    await usage.activities({
      kind,
      q,
      from: timeParam(url, "from"),
      to: timeParam(url, "to"),
      before: intParam(url, "before", 1, Number.MAX_SAFE_INTEGER),
      limit: intParam(url, "limit", 1, MAX_ACTIVITY_PAGE),
    }),
  );
}

export async function verifyActivities(usage: AccountUsageStub): Promise<Response> {
  return json(200, await usage.verifyActivities());
}

export async function getRateCard(usage: AccountUsageStub): Promise<Response> {
  return json(200, { entries: await usage.rateCard() });
}

/** PUT /rate-card: `{ entries: RateCardEntry[] }` replaces the whole card. */
export async function putRateCard(
  usage: AccountUsageStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  return json(200, { entries: unwrap(await usage.replaceRateCard(body.entries, actorOf(caller))) });
}

export async function listBalances(usage: AccountUsageStub): Promise<Response> {
  return json(200, { balances: await usage.balances() });
}

/** POST /balances/refresh: read live balances with the account's saved keys, then store them. */
export async function refreshBalances(
  app: AppContext,
  usage: AccountUsageStub,
  caller: ApiCaller,
): Promise<Response> {
  const keys = await app.accounts.providerKeys(caller.account.id);
  const balances = await fetchProviderBalances(keys, app.fetch, Date.now());
  await usage.saveBalances(balances, actorOf(caller));
  return json(200, { balances });
}
