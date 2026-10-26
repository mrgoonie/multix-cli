/**
 * REST handlers for the account's usage ledger: summaries, operations, cost
 * adjustments, export and import, budgets and the activity log. Every call
 * goes to the calling account's own ledger object (MULTIX_LEDGER by account
 * id), so one account never reads or changes another's records.
 *
 * Unknown stays null: a cost or token count nobody reported is returned as
 * null, never 0, and summaries count those operations separately.
 */

import type { AppContext, AppDeps } from "../app-context.js";
import { ledgerFor } from "../app-context.js";
import { json, text } from "../http-responses.js";
import type { AccountLedgerStub } from "../ledger/account-ledger.js";
import { parseBudgetInput } from "../ledger/budget-input.js";
import {
  LedgerQueryError,
  operationsCsv,
  parseLimit,
  parseTime,
  parseUsageQuery,
} from "../ledger/ledger-query.js";
import {
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_ENTRIES,
  importRecords,
} from "../ledger/ledger-records.js";
import type { AdjustmentKind } from "../ledger/ledger-types.js";
import { MAX_PAGE_SIZE } from "../ledger/usage-ledger.js";
import type { ApiCaller } from "./account-api-handlers.js";
import { ApiError, readJsonObject } from "./api-http.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_ADJUSTMENT_USD = 1_000_000;
export const MAX_NOTE_CHARS = 200;
export const MAX_ACTIVITY_QUERY_CHARS = 100;

const OPERATION_CURSOR = /^\d{1,16}~[A-Za-z0-9_-]{1,160}$/;
const ACTIVITY_CURSOR = /^\d{1,16}$/;
const ACTIVITY_KIND = /^[a-z0-9_.]{1,64}$/;
const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ["refund", "correction"];
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

const actorOf = (caller: ApiCaller) => `api_key:${caller.keyId}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The caller's ledger; 503 `ledger_unavailable` when the Worker has no MULTIX_LEDGER binding. */
export function usageLedger(app: AppContext, deps: AppDeps, userId: string): AccountLedgerStub {
  const ledger = ledgerFor(app.env, deps, userId);
  if (!ledger) {
    throw new ApiError(503, "ledger_unavailable", "Usage records are not available on this server");
  }
  return ledger;
}

/** GET /usage/summary: totals, optional groups, daily series and every budget's status. */
export async function getUsageSummary(ledger: AccountLedgerStub, url: URL): Promise<Response> {
  const query = parseUsageQuery(url.searchParams, Date.now());
  const [summary, budgets] = await Promise.all([
    ledger.summary(query.filter, query.groupBy, query.tzOffsetMinutes),
    ledger.budgetStatuses(),
  ]);
  return json(200, { ...summary, budgets });
}

/** GET /usage/operations: newest first, paged with `next_cursor`. */
export async function listOperations(ledger: AccountLedgerStub, url: URL): Promise<Response> {
  const params = url.searchParams;
  const { filter } = parseUsageQuery(params, Date.now());
  const limit = parseLimit(params, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const cursor = params.get("cursor") || undefined;
  if (cursor !== undefined && !OPERATION_CURSOR.test(cursor)) {
    throw new LedgerQueryError("cursor must be the next_cursor of a previous page");
  }
  return json(200, await ledger.listOperations(filter, limit, cursor));
}

/** GET /usage/operations/{op_id}: the operation and its cost adjustments. */
export async function getOperation(ledger: AccountLedgerStub, opId: string): Promise<Response> {
  const found = await ledger.getOperation(opId);
  if (!found) throw new ApiError(404, "not_found", "Operation not found");
  return json(200, found);
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const note = typeof value === "string" ? value.trim() : undefined;
  if (note === undefined || note.length > MAX_NOTE_CHARS || CONTROL.test(note)) {
    throw new LedgerQueryError(
      `note must be a string of at most ${MAX_NOTE_CHARS} characters without control characters`,
    );
  }
  return note || null;
}

/** POST /usage/operations/{op_id}/adjustments: `{ kind, amount_usd, note? }`. */
export async function postAdjustment(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  opId: string,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  const kind = body.kind;
  if (typeof kind !== "string" || !(ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
    throw new LedgerQueryError(`kind must be one of: ${ADJUSTMENT_KINDS.join(", ")}`);
  }
  const amount = body.amount_usd;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    Math.abs(amount) > MAX_ADJUSTMENT_USD
  ) {
    throw new LedgerQueryError(
      `amount_usd must be a number between -${MAX_ADJUSTMENT_USD} and ${MAX_ADJUSTMENT_USD}`,
    );
  }
  const note = parseNote(body.note);
  const adjustment = await ledger.addAdjustment(
    opId,
    kind as AdjustmentKind,
    amount,
    note,
    actorOf(caller),
  );
  if (!adjustment) throw new ApiError(404, "not_found", "Operation not found");
  return json(201, adjustment);
}

/** GET /usage/export?format=csv|json: oldest first, capped; the export itself is logged. */
export async function exportUsage(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  url: URL,
): Promise<Response> {
  const params = url.searchParams;
  const format = params.get("format") || "csv";
  if (format !== "csv" && format !== "json") {
    throw new LedgerQueryError("format must be one of: csv, json");
  }
  const { filter } = parseUsageQuery(params, Date.now());
  const result = await ledger.exportOperations(filter, actorOf(caller), format);
  if (format === "json") return json(200, result);
  return text(200, operationsCsv(result.operations), {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="multix-usage-${day(filter.from)}-${day(filter.to)}.csv"`,
    "cache-control": "no-store",
    ...(result.truncated ? { "x-multix-truncated": "true" } : {}),
  });
}

/**
 * POST /usage/import: `{ entries: ImportEntry[] }` as sent by `multix history
 * push`. Invalid entries are counted as rejected; ids already recorded count
 * as duplicates, so a retried batch changes nothing.
 */
export async function importUsage(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request, MAX_IMPORT_BODY_BYTES);
  const entries = body.entries;
  if (!Array.isArray(entries)) {
    throw new ApiError(400, "bad_request", 'The body must be { "entries": [...] }');
  }
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw new ApiError(
      400,
      "bad_request",
      `Send at most ${MAX_IMPORT_ENTRIES} entries per request`,
    );
  }
  const actor = actorOf(caller);
  const { operations, rejected } = importRecords(entries, actor);
  const { accepted, duplicates } = operations.length
    ? await ledger.importOperations(operations, actor)
    : { accepted: 0, duplicates: 0 };
  return json(200, { accepted, duplicates, rejected });
}

/** DELETE /usage/data?confirm=delete: every operation, adjustment, alert and activity; budgets stay. */
export async function deleteUsageData(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  url: URL,
): Promise<Response> {
  if (url.searchParams.get("confirm") !== "delete") {
    throw new ApiError(
      400,
      "bad_request",
      "Add ?confirm=delete to delete every usage record of this account",
    );
  }
  await ledger.deleteAllData(actorOf(caller));
  return json(200, { deleted: true });
}

export async function listBudgets(ledger: AccountLedgerStub): Promise<Response> {
  return json(200, { budgets: await ledger.budgetStatuses() });
}

async function budgetStatusOrNotFound(ledger: AccountLedgerStub, id: string, status = 200) {
  const budget = await ledger.budgetStatus(id);
  if (!budget) throw new ApiError(404, "not_found", "Budget not found");
  return json(status, budget);
}

export async function createBudget(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const input = parseBudgetInput(await readJsonObject(request));
  const budget = await ledger.createBudget(input, actorOf(caller));
  if (!budget) {
    throw new ApiError(
      409,
      "budget_limit",
      "This account already has the maximum number of budgets",
    );
  }
  return budgetStatusOrNotFound(ledger, budget.id, 201);
}

export function getBudget(ledger: AccountLedgerStub, id: string): Promise<Response> {
  return budgetStatusOrNotFound(ledger, id);
}

/** PUT /budgets/{id}: replaces the whole budget (same body as create). */
export async function putBudget(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  id: string,
  request: Request,
): Promise<Response> {
  const input = parseBudgetInput(await readJsonObject(request));
  if (!(await ledger.updateBudget(id, input, actorOf(caller)))) {
    throw new ApiError(404, "not_found", "Budget not found");
  }
  return budgetStatusOrNotFound(ledger, id);
}

export async function deleteBudget(
  ledger: AccountLedgerStub,
  caller: ApiCaller,
  id: string,
): Promise<Response> {
  if (!(await ledger.deleteBudget(id, actorOf(caller)))) {
    throw new ApiError(404, "not_found", "Budget not found");
  }
  return json(200, { deleted: true });
}

/** GET /activities?from&to&kind&q&limit&cursor: newest first; `kind` matches a prefix. */
export async function listActivities(ledger: AccountLedgerStub, url: URL): Promise<Response> {
  const params = url.searchParams;
  const from = parseTime(params.get("from"), "from");
  const to = parseTime(params.get("to"), "to");
  if (from !== undefined && to !== undefined && from >= to) {
    throw new LedgerQueryError("from must be before to");
  }
  const kind = params.get("kind") || undefined;
  if (kind !== undefined && !ACTIVITY_KIND.test(kind)) {
    throw new LedgerQueryError("kind must be 1-64 lower-case letters, digits, '_' or '.'");
  }
  const q = params.get("q")?.trim() || undefined;
  if (q !== undefined && (q.length > MAX_ACTIVITY_QUERY_CHARS || CONTROL.test(q))) {
    throw new LedgerQueryError(`q must be at most ${MAX_ACTIVITY_QUERY_CHARS} characters`);
  }
  const cursor = params.get("cursor") || undefined;
  if (cursor !== undefined && !ACTIVITY_CURSOR.test(cursor)) {
    throw new LedgerQueryError("cursor must be the next_cursor of a previous page");
  }
  const limit = parseLimit(params, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = await ledger.listActivities(
    { from, to, kind, q, before: cursor === undefined ? undefined : Number(cursor) },
    limit,
  );
  return json(200, page);
}

/** GET /activities/verify: recompute the activity hash chain. */
export async function verifyActivities(ledger: AccountLedgerStub): Promise<Response> {
  return json(200, await ledger.verifyActivities());
}
