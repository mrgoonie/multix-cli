/**
 * Usage ledger pages of the dashboard.
 *
 *   GET  /dashboard/overview                  this month and last 30 days, budgets, failures, activity
 *   GET  /dashboard/usage                     filters, daily chart, breakdown
 *   GET  /dashboard/usage/export?format=csv|json   download the filtered operations (logged)
 *   POST /dashboard/usage/delete              delete every ledger row (needs "DELETE" typed)
 *   GET  /dashboard/budgets                   budget states and forms
 *   POST /dashboard/budgets                   create a budget
 *   POST /dashboard/budgets/{id}              update a budget
 *   POST /dashboard/budgets/{id}/delete       delete a budget
 *   GET  /dashboard/traces                    operations, newest first
 *   GET  /dashboard/traces/{op_id}            one operation
 *   GET  /dashboard/activity                  activity log with integrity check
 *
 * GETs need a session; POSTs arrive from dashboard-routes.ts after its
 * Origin, session and CSRF checks. Each account only ever reaches its own
 * ledger object (`ledgerFor(…, account.id)`), so another account's ids are
 * simply not found. Without a MULTIX_LEDGER binding every page answers a
 * "not configured" notice.
 */

import {
  type AppContext,
  type AppDeps,
  type SignedIn,
  ledgerFor,
  signedInSession,
} from "../app-context.js";
import { csrfToken } from "../auth/signed-cookies.js";
import { SECURITY_HEADERS, escapeHtml, html, redirect, text } from "../http-responses.js";
import type { AccountLedgerStub } from "../ledger/account-ledger.js";
import { parseBudgetInput } from "../ledger/budget-input.js";
import { LedgerQueryError, operationsCsv, parseUsageQuery } from "../ledger/ledger-query.js";
import type { Operation, OperationFilter } from "../ledger/ledger-types.js";
import { type ActivityFilterValues, activityPage } from "../pages/activity-page.js";
import { type BudgetFormValues, budgetsPage } from "../pages/budgets-page.js";
import { finopsPage, isoDay } from "../pages/finops-format.js";
import { messagePage } from "../pages/page-layout.js";
import { type TraceFilterValues, traceDetailPage, tracesPage } from "../pages/traces-page.js";
import { type UsageFormValues, usageCostsPage } from "../pages/usage-costs-page.js";
import { overviewPage } from "../pages/usage-overview-page.js";
import type { Notice } from "./r2-settings-routes.js";

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OP_CURSOR = /^\d{1,16}~[A-Za-z0-9_-]{1,160}$/;
const ACTIVITY_KIND = /^[A-Za-z0-9_.-]{1,64}$/;
const FINOPS_PATH = /^\/dashboard\/(overview|usage|budgets|traces|activity)(\/|$)/;
/** Filter parameters carried over to the export links. */
const USAGE_PARAMS = [
  "from",
  "to",
  "provider",
  "model",
  "source",
  "status",
  "command",
  "client_id",
  "project_id",
] as const;

const NOTICES: Record<string, Notice> = {
  "usage-deleted": { text: "All usage data of this account was deleted. Budgets were kept." },
  "delete-confirm": {
    text: "Nothing was deleted: type DELETE in the box to confirm.",
    warn: true,
  },
  "budget-created": { text: "Budget created." },
  "budget-saved": { text: "Budget saved." },
  "budget-deleted": { text: "Budget deleted." },
  "budget-not-found": { text: "That budget was not found; it may already be gone.", warn: true },
  "budget-limit": {
    text: "Budget not created: an account can hold at most 20 budgets. Delete one first.",
    warn: true,
  },
};

export function isFinopsPath(pathname: string): boolean {
  return FINOPS_PATH.test(pathname);
}

const actorFor = (userId: string) => `user:${userId}`;

function noticeFrom(url: URL): Notice | undefined {
  const key = url.searchParams.get("notice") ?? "";
  return Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
}

function notConfigured(): Response {
  return html(
    200,
    messagePage(
      "Usage ledger not configured",
      "This server has no usage ledger, so usage, costs, budgets, traces and activity are not recorded. Your account settings still work.",
      { href: "/dashboard", label: "Back to your account" },
    ),
  );
}

function notFound(message: string): Response {
  return html(
    404,
    finopsPage(
      "Not found",
      "traces",
      `<section class="card"><h1>Not found</h1><p>${escapeHtml(message)}</p><p><a class="btn secondary" href="/dashboard/traces">All traces</a></p></section>`,
    ),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof LedgerQueryError) return error.message;
  throw error;
}

/** Date inputs send YYYY-MM-DD; an inclusive "to" day ends at the next midnight (UTC). */
function inclusiveTo(raw: string | null): string | null {
  if (raw && DAY.test(raw)) return String(Date.parse(raw) + DAY_MS);
  return raw;
}

function usageParams(source: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of [...USAGE_PARAMS, "group_by"]) {
    const value = source.get(name);
    if (value !== null && value !== "") params.set(name, value);
  }
  const to = inclusiveTo(params.get("to"));
  if (to !== null) params.set("to", to);
  return params;
}

// ---- overview -------------------------------------------------------------

async function recentFailures(ledger: AccountLedgerStub): Promise<Operation[]> {
  const pages = await Promise.all(
    (["failed", "timed_out", "canceled"] as const).map((status) =>
      ledger.listOperations({ status }, 5),
    ),
  );
  return pages
    .flatMap((p) => p.operations)
    .sort((a, b) => b.started_at - a.started_at || (a.op_id < b.op_id ? 1 : -1))
    .slice(0, 5);
}

async function showOverview(ledger: AccountLedgerStub): Promise<Response> {
  const now = Date.now();
  const today = new Date(now);
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const to = now + 1;
  const [month, last30, budgets, failed, activities] = await Promise.all([
    ledger.summary({ from: monthStart, to }, null, 0),
    ledger.summary({ from: now - 30 * DAY_MS, to }, null, 0),
    ledger.budgetStatuses(),
    recentFailures(ledger),
    ledger.listActivities({}, 5),
  ]);
  return html(
    200,
    overviewPage({
      month: month.totals,
      monthLabel: new Date(monthStart).toISOString().slice(0, 7),
      last30: last30.totals,
      budgets,
      failed,
      activities: activities.activities,
    }),
  );
}

// ---- usage & costs --------------------------------------------------------

async function showUsage(
  ledger: AccountLedgerStub,
  url: URL,
  csrf: string,
  notice?: Notice,
): Promise<Response> {
  const raw = url.searchParams;
  const form: UsageFormValues = {
    from: raw.get("from") ?? "",
    to: raw.get("to") ?? "",
    provider: raw.get("provider") ?? "",
    model: raw.get("model") ?? "",
    source: raw.get("source") ?? "",
    status: raw.get("status") ?? "",
    command: raw.get("command") ?? "",
    group_by: raw.get("group_by") || "provider",
  };
  const exportParams = new URLSearchParams();
  for (const name of USAGE_PARAMS) {
    const value = raw.get(name);
    if (value) exportParams.set(name, value);
  }
  const params = usageParams(raw);
  if (!params.has("group_by")) params.set("group_by", "provider");
  try {
    const query = parseUsageQuery(params, Date.now());
    const summary = await ledger.summary(query.filter, query.groupBy, 0);
    form.from = isoDay(query.filter.from);
    form.to = isoDay(query.filter.to - 1);
    return html(
      200,
      usageCostsPage({ form, summary, exportQuery: exportParams.toString(), csrf, notice }),
    );
  } catch (error) {
    const message = errorMessage(error);
    return html(
      400,
      usageCostsPage({ form, summary: null, error: message, exportQuery: "", csrf, notice }),
    );
  }
}

async function exportUsage(ledger: AccountLedgerStub, userId: string, url: URL): Promise<Response> {
  const format = url.searchParams.get("format");
  if (format !== "csv" && format !== "json") return text(400, "format must be csv or json");
  let filter: OperationFilter & { from: number; to: number };
  try {
    filter = parseUsageQuery(usageParams(url.searchParams), Date.now()).filter;
  } catch (error) {
    return text(400, errorMessage(error));
  }
  const result = await ledger.exportOperations(filter, actorFor(userId), format);
  const name = `multix-usage-${isoDay(filter.from)}-to-${isoDay(filter.to - 1)}.${format}`;
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "content-disposition": `attachment; filename="${name}"`,
    "x-multix-export-truncated": String(result.truncated),
  };
  if (format === "csv") {
    return new Response(operationsCsv(result.operations), {
      status: 200,
      headers: { ...headers, "content-type": "text/csv; charset=utf-8" },
    });
  }
  const body = {
    from: filter.from,
    to: filter.to,
    truncated: result.truncated,
    operations: result.operations,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...headers, "content-type": "application/json" },
  });
}

// ---- traces ---------------------------------------------------------------

async function showTraces(ledger: AccountLedgerStub, url: URL): Promise<Response> {
  const raw = url.searchParams;
  const form: TraceFilterValues = {
    status: raw.get("status") ?? "",
    provider: raw.get("provider") ?? "",
    source: raw.get("source") ?? "",
  };
  const filterParams = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v) filterParams.set(k, v);
  const cursor = raw.get("cursor") || undefined;
  try {
    if (cursor !== undefined && !OP_CURSOR.test(cursor)) {
      throw new LedgerQueryError("cursor is not valid; start again from the newest operations");
    }
    const { filter } = parseUsageQuery(filterParams, Date.now());
    const { provider, status, source } = filter;
    const page = await ledger.listOperations({ provider, status, source }, PAGE_SIZE, cursor);
    let olderQuery: string | null = null;
    if (page.next_cursor) {
      const older = new URLSearchParams(filterParams);
      older.set("cursor", page.next_cursor);
      olderQuery = older.toString();
    }
    return html(
      200,
      tracesPage({ form, operations: page.operations, olderQuery, paged: cursor !== undefined }),
    );
  } catch (error) {
    const message = errorMessage(error);
    return html(
      400,
      tracesPage({ form, operations: [], olderQuery: null, paged: false, error: message }),
    );
  }
}

async function showTrace(ledger: AccountLedgerStub, opId: string): Promise<Response> {
  if (!ID.test(opId)) return notFound("No operation has that id.");
  const found = await ledger.getOperation(opId);
  if (!found) return notFound("No operation with that id was found in your account.");
  return html(200, traceDetailPage(found.operation, found.adjustments));
}

// ---- activity -------------------------------------------------------------

function activityDay(raw: string, name: string, inclusive: boolean): number | undefined {
  if (raw === "") return undefined;
  if (!DAY.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new LedgerQueryError(`${name} must be a date (YYYY-MM-DD)`);
  }
  return Date.parse(raw) + (inclusive ? DAY_MS : 0);
}

async function showActivity(ledger: AccountLedgerStub, url: URL): Promise<Response> {
  const raw = url.searchParams;
  const form: ActivityFilterValues = {
    q: (raw.get("q") ?? "").trim(),
    kind: (raw.get("kind") ?? "").trim(),
    from: raw.get("from") ?? "",
    to: raw.get("to") ?? "",
  };
  const beforeRaw = raw.get("before") ?? "";
  const integrity = await ledger.verifyActivities();
  try {
    if (form.q.length > 100) throw new LedgerQueryError("search may be at most 100 characters");
    if (form.kind && !ACTIVITY_KIND.test(form.kind)) {
      throw new LedgerQueryError(
        "kind may only hold letters, digits, dots, dashes and underscores",
      );
    }
    if (beforeRaw && !/^[1-9]\d{0,14}$/.test(beforeRaw)) {
      throw new LedgerQueryError(
        "the page cursor is not valid; start again from the newest entries",
      );
    }
    const from = activityDay(form.from, "from", false);
    const to = activityDay(form.to, "to", true);
    if (from !== undefined && to !== undefined && from >= to) {
      throw new LedgerQueryError("from must be before to");
    }
    const page = await ledger.listActivities(
      {
        from,
        to,
        kind: form.kind || undefined,
        q: form.q || undefined,
        before: beforeRaw ? Number(beforeRaw) : undefined,
      },
      PAGE_SIZE,
    );
    let olderQuery: string | null = null;
    if (page.next_cursor) {
      const older = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) if (v) older.set(k, v);
      older.set("before", page.next_cursor);
      olderQuery = older.toString();
    }
    return html(
      200,
      activityPage({
        form,
        activities: page.activities,
        integrity,
        olderQuery,
        paged: beforeRaw !== "",
      }),
    );
  } catch (error) {
    const message = errorMessage(error);
    return html(
      400,
      activityPage({
        form,
        activities: [],
        integrity,
        olderQuery: null,
        paged: false,
        error: message,
      }),
    );
  }
}

// ---- budgets --------------------------------------------------------------

async function showBudgets(
  ledger: AccountLedgerStub,
  csrf: string,
  notice?: Notice,
  draft?: BudgetFormValues,
  status = 200,
): Promise<Response> {
  return html(status, budgetsPage({ budgets: await ledger.budgetStatuses(), csrf, notice, draft }));
}

function budgetFormFields(form: FormData): BudgetFormValues {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    name: field("name"),
    scope_kind: field("scope_kind"),
    scope_value: field("scope_value"),
    period: field("period"),
    limit_usd: field("limit_usd"),
    thresholds: field("thresholds"),
  };
}

/** Form strings to the JSON shape parseBudgetInput validates (numbers stay numbers or fail). */
function budgetBody(v: BudgetFormValues): Record<string, unknown> {
  const thresholds = v.thresholds
    .split(/[\s,;%]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
  return {
    name: v.name,
    scope_kind: v.scope_kind,
    scope_value: v.scope_value || null,
    period: v.period,
    limit_usd: /^\d+(\.\d+)?$/.test(v.limit_usd) ? Number(v.limit_usd) : v.limit_usd,
    thresholds: thresholds.length ? thresholds : undefined,
  };
}

async function budgetPost(
  ledger: AccountLedgerStub,
  actor: string,
  csrf: string,
  pathname: string,
  form: FormData,
): Promise<Response> {
  const match = /^\/dashboard\/budgets(?:\/([^/]+)(\/delete)?)?$/.exec(pathname);
  if (!match) return text(404, "Not Found");
  const id = match[1];
  if (id !== undefined && !ID.test(id))
    return redirect("/dashboard/budgets?notice=budget-not-found");
  if (id !== undefined && match[2]) {
    const deleted = await ledger.deleteBudget(id, actor);
    return redirect(`/dashboard/budgets?notice=${deleted ? "budget-deleted" : "budget-not-found"}`);
  }
  const values = budgetFormFields(form);
  let input: ReturnType<typeof parseBudgetInput>;
  try {
    input = parseBudgetInput(budgetBody(values));
  } catch (error) {
    const verb = id === undefined ? "created" : "saved";
    const notice = { text: `Budget not ${verb}: ${errorMessage(error)}.`, warn: true };
    return showBudgets(ledger, csrf, notice, id === undefined ? values : undefined, 400);
  }
  if (id === undefined) {
    const created = await ledger.createBudget(input, actor);
    return redirect(`/dashboard/budgets?notice=${created ? "budget-created" : "budget-limit"}`);
  }
  const updated = await ledger.updateBudget(id, input, actor);
  return redirect(`/dashboard/budgets?notice=${updated ? "budget-saved" : "budget-not-found"}`);
}

// ---- entry points -----------------------------------------------------------

export async function handleFinopsGet(
  ctx: AppContext,
  deps: AppDeps,
  request: Request,
): Promise<Response> {
  const signedIn = await signedInSession(ctx, request);
  if (!signedIn) return redirect("/dashboard", {}, 302);
  const { account, session } = signedIn;
  const ledger = ledgerFor(ctx.env, deps, account.id);
  if (!ledger) return notConfigured();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const csrf = () => csrfToken(ctx.sessionSecret, session);

  if (path === "/dashboard/overview") return showOverview(ledger);
  if (path === "/dashboard/usage") return showUsage(ledger, url, await csrf(), noticeFrom(url));
  if (path === "/dashboard/usage/export") {
    // A HEAD (link prefetch, scanners) must not be logged as an export.
    if (request.method === "HEAD")
      return new Response(null, { status: 200, headers: SECURITY_HEADERS });
    return exportUsage(ledger, account.id, url);
  }
  if (path === "/dashboard/budgets") return showBudgets(ledger, await csrf(), noticeFrom(url));
  if (path === "/dashboard/traces") return showTraces(ledger, url);
  if (path.startsWith("/dashboard/traces/")) {
    const opId = path.slice("/dashboard/traces/".length);
    return showTrace(ledger, opId);
  }
  if (path === "/dashboard/activity") return showActivity(ledger, url);
  return text(404, "Not Found");
}

/** POSTs under the usage paths, after dashboard-routes.ts checked Origin, session and CSRF. */
export async function handleFinopsPost(
  ctx: AppContext,
  deps: AppDeps,
  signedIn: SignedIn,
  form: FormData,
  pathname: string,
): Promise<Response> {
  const { account, session } = signedIn;
  const ledger = ledgerFor(ctx.env, deps, account.id);
  if (!ledger) return notConfigured();
  const actor = actorFor(account.id);

  if (pathname === "/dashboard/usage/delete") {
    if (form.get("confirm") !== "DELETE") return redirect("/dashboard/usage?notice=delete-confirm");
    await ledger.deleteAllData(actor);
    return redirect("/dashboard/usage?notice=usage-deleted");
  }
  if (pathname === "/dashboard/budgets" || pathname.startsWith("/dashboard/budgets/")) {
    const csrf = await csrfToken(ctx.sessionSecret, session);
    return budgetPost(ledger, actor, csrf, pathname, form);
  }
  return text(404, "Not Found");
}
