/**
 * Usage dashboard tabs, called by dashboard-routes.ts for a signed-in session.
 *
 *   GET  /dashboard/overview                      last 30 days: KPIs, daily cost, budgets, balances
 *   GET  /dashboard/usage                         filters, KPIs, series, breakdowns, events
 *   GET  /dashboard/usage/export?format=csv|json  the filtered events as a download
 *   GET  /dashboard/budgets                       budgets, rate card, debug capture
 *   GET  /dashboard/traces                        event list
 *   GET  /dashboard/traces/{id}                   one event: spans, facts, adjustments
 *   GET  /dashboard/activities                    activity log (verify=1 checks the chain)
 *   POST /dashboard/balances/refresh              read provider balances with the saved keys
 *   POST /dashboard/budgets                       create, update or delete a budget
 *   POST /dashboard/rate-card                     replace the account rate card
 *   POST /dashboard/debug-capture                 turn stderr capture on or off
 *   POST /dashboard/traces/{id}/adjustments       add a refund, correction or billed amount
 *   POST /dashboard/traces/{id}/debug-log         show a captured stderr tail (logged)
 *
 * The ledger lives in the account's own Durable Object, so an event id from
 * another account is simply not found. POSTs arrive here after the Origin,
 * session and CSRF checks.
 */

import type { Account } from "../accounts/account-store.js";
import { type AppContext, type AppDeps, type SignedIn, usageLedgerFor } from "../app-context.js";
import { csrfToken } from "../auth/signed-cookies.js";
import { html, json, redirect, text } from "../http-responses.js";
import { ACTIVITY_KIND_PREFIXES, activitiesPage } from "../pages/activities-page.js";
import { BUDGET_FORM_FIELDS, type BudgetFormValues, budgetsPage } from "../pages/budgets-page.js";
import {
  type DashboardTab,
  LEDGER_FAILED,
  LEDGER_MISSING,
  type PageNotice,
  dashboardShell,
} from "../pages/dashboard-nav.js";
import { overviewPage } from "../pages/overview-page.js";
import { tracePage } from "../pages/trace-page.js";
import { RANGE_PRESETS, type RangePreset } from "../pages/usage-components.js";
import { tracesPage, usagePage } from "../pages/usage-page.js";
import { logEvent } from "../redaction.js";
import type { AccountUsageStub } from "../usage/account-usage.js";
import { fetchProviderBalances } from "../usage/provider-balances.js";
import { FilterError, parseUsageFilter, toCsv } from "../usage/usage-queries.js";
import type { UsageFilter } from "../usage/usage-types.js";

const DAY = 86_400_000;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BUDGET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RATE_CARD_TEXT = 100_000;
const RANGE_MS: Record<RangePreset, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

const TAB_TITLES: Record<Exclude<DashboardTab, "settings">, string> = {
  overview: "Overview",
  usage: "Usage & Costs",
  budgets: "Budgets",
  traces: "Traces",
  activities: "Activities",
};

const NOTICES: Record<string, PageNotice> = {
  "balances-refreshed": { text: "Balances refreshed." },
  "balances-failed": { text: "Balances could not be refreshed. Try again later.", warn: true },
  "budget-created": { text: "Budget created." },
  "budget-updated": { text: "Budget saved." },
  "budget-deleted": { text: "Budget deleted." },
  "budget-not-found": { text: "That budget was not found; it may already be gone.", warn: true },
  "rate-card-saved": { text: "Rate card saved. New runs are estimated with it." },
  "debug-on": { text: "Debug capture is on for 7 days." },
  "debug-off": { text: "Debug capture is off and kept logs were deleted." },
  adjusted: { text: "Adjustment added." },
};

const USAGE_GET_PATHS = new Set([
  "/dashboard/overview",
  "/dashboard/usage",
  "/dashboard/usage/export",
  "/dashboard/budgets",
  "/dashboard/traces",
  "/dashboard/activities",
]);

const USAGE_POST_PATHS = new Set([
  "/dashboard/balances/refresh",
  "/dashboard/budgets",
  "/dashboard/rate-card",
  "/dashboard/debug-capture",
]);

const TRACE_PATH_RE = /^\/dashboard\/traces\/([^/]+)$/;
const TRACE_POST_RE = /^\/dashboard\/traces\/([^/]+)\/(adjustments|debug-log)$/;

export function isUsageDashboardGet(pathname: string): boolean {
  return USAGE_GET_PATHS.has(pathname) || TRACE_PATH_RE.test(pathname);
}

export function isUsageDashboardPost(pathname: string): boolean {
  return USAGE_POST_PATHS.has(pathname) || TRACE_POST_RE.test(pathname);
}

function tabOf(pathname: string): Exclude<DashboardTab, "settings"> {
  const segment = pathname.split("/")[2] ?? "";
  if (segment === "usage" || segment === "traces" || segment === "activities") return segment;
  if (segment === "budgets" || segment === "rate-card" || segment === "debug-capture") {
    return "budgets";
  }
  return "overview";
}

function noticeFrom(url: URL): PageNotice | undefined {
  const key = url.searchParams.get("notice") ?? "";
  return Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
}

/** A tab with only its heading and a notice (no ledger, or the ledger failed). */
function emptyTab(tab: Exclude<DashboardTab, "settings">, notice: PageNotice, status = 200) {
  const title = TAB_TITLES[tab];
  return html(
    status,
    dashboardShell(title, tab, `<h1>${title.replace("&", "&amp;")}</h1>`, notice),
  );
}

function notFound(): Response {
  return html(
    404,
    dashboardShell(
      "Not found",
      "traces",
      `<h1>Trace not found</h1><p>No run with that id exists in your account. <a href="/dashboard/traces">Back to traces</a></p>`,
    ),
  );
}

/** Filters from the query; a `range` preset replaces from/to. Bad input falls back to 30 days. */
function readFilter(
  params: URLSearchParams,
  now: number,
): { filter: UsageFilter; range: string; error?: string } {
  const p = new URLSearchParams(params);
  const rangeParam = p.get("range") ?? "";
  const preset = (RANGE_PRESETS as readonly string[]).includes(rangeParam)
    ? (rangeParam as RangePreset)
    : undefined;
  if (preset) {
    p.set("from", String(now - RANGE_MS[preset]));
    p.set("to", String(now));
  }
  const range = preset ?? (p.get("from") || p.get("to") ? "custom" : "30d");
  try {
    return { filter: parseUsageFilter(p, now), range };
  } catch (error) {
    if (!(error instanceof FilterError)) throw error;
    return {
      filter: parseUsageFilter(new URLSearchParams(), now),
      range: "30d",
      error: `Filters not applied: ${error.message}.`,
    };
  }
}

async function eventPage(usage: AccountUsageStub, filter: UsageFilter, params: URLSearchParams) {
  const cursor = params.get("cursor") || null;
  const result = await usage.events(filter, cursor, 50);
  if (result.ok) return { page: { ...result.value, cursor }, error: undefined };
  const first = await usage.events(filter, null, 50);
  return {
    page: first.ok ? { ...first.value, cursor: null } : { items: [], next: null, cursor: null },
    error: `Page not found: ${result.error}.`,
  };
}

function pickNotice(...candidates: Array<PageNotice | string | undefined>): PageNotice | undefined {
  for (const c of candidates) {
    if (typeof c === "string") return { text: c, warn: true };
    if (c) return c;
  }
  return undefined;
}

async function exportResponse(
  usage: AccountUsageStub,
  params: URLSearchParams,
  actor: string,
  now: number,
): Promise<Response> {
  const format = params.get("format");
  if (format !== "csv" && format !== "json") return text(400, "format must be csv or json");
  let filter: UsageFilter;
  try {
    filter = parseUsageFilter(params, now);
  } catch (error) {
    if (error instanceof FilterError) return text(400, error.message);
    throw error;
  }
  const { items, truncated } = await usage.exportEvents(filter, actor, format);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const filename = `multix-usage-${day(filter.from)}-to-${day(filter.to - 1)}.${format}`;
  const headers = {
    "content-disposition": `attachment; filename="${filename}"`,
    "x-multix-export-truncated": String(truncated),
  };
  if (format === "json") return json(200, { filter, truncated, items }, headers);
  return text(200, toCsv(items), { ...headers, "content-type": "text/csv; charset=utf-8" });
}

function activityQuery(params: URLSearchParams) {
  const kindParam = params.get("kind") ?? "";
  const kind = ACTIVITY_KIND_PREFIXES.some(([k]) => k === kindParam) ? kindParam : "";
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const day = (name: string) => {
    const raw = params.get(name) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : undefined;
  };
  const from = day("from");
  const toDay = day("to");
  const to = toDay === undefined ? undefined : toDay + DAY;
  const beforeRaw = params.get("before") ?? "";
  const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
  return { kind, q, from, to, before };
}

async function budgetsResponse(
  usage: AccountUsageStub,
  csrf: string,
  extra: { status?: number; notice?: PageNotice; draft?: BudgetFormValues; rateCardDraft?: string },
): Promise<Response> {
  const [statuses, rateCard, debugUntil] = await Promise.all([
    usage.budgets(),
    usage.rateCard(),
    usage.debugCaptureUntil(),
  ]);
  return html(
    extra.status ?? 200,
    budgetsPage({
      csrf,
      statuses,
      rateCard,
      debugUntil,
      now: Date.now(),
      notice: extra.notice,
      draft: extra.draft,
      rateCardDraft: extra.rateCardDraft,
    }),
  );
}

async function traceResponse(
  usage: AccountUsageStub,
  csrf: string,
  id: string,
  extra: { status?: number; notice?: PageNotice; debugLog?: string | null },
): Promise<Response> {
  const detail = await usage.event(id);
  if (!detail) return notFound();
  return html(extra.status ?? 200, tracePage({ csrf, detail, ...extra }));
}

async function renderGet(
  usage: AccountUsageStub,
  url: URL,
  account: Account,
  csrf: string,
): Promise<Response> {
  const now = Date.now();
  const { pathname, searchParams: params } = url;
  const actor = `dashboard:${account.id}`;
  const notice = noticeFrom(url);

  if (pathname === "/dashboard/overview") {
    const filter: UsageFilter = { from: now - 30 * DAY, to: now };
    const [summary, budgets, balances] = await Promise.all([
      usage.summary(filter, 0),
      usage.budgets(),
      usage.balances(),
    ]);
    return html(200, overviewPage({ csrf, summary, budgets, balances, notice }));
  }

  if (pathname === "/dashboard/usage/export") return exportResponse(usage, params, actor, now);

  if (pathname === "/dashboard/usage" || pathname === "/dashboard/traces") {
    const { filter, range, error } = readFilter(params, now);
    const events = await eventPage(usage, filter, params);
    const pageNotice = pickNotice(error, events.error, notice);
    if (pathname === "/dashboard/traces") {
      return html(200, tracesPage({ filter, range, events: events.page, notice: pageNotice }));
    }
    const summary = await usage.summary(filter, 0);
    return html(
      200,
      usagePage({ filter, range, summary, events: events.page, notice: pageNotice }),
    );
  }

  if (pathname === "/dashboard/budgets") return budgetsResponse(usage, csrf, { notice });

  if (pathname === "/dashboard/activities") {
    const query = activityQuery(params);
    const [list, verify] = await Promise.all([
      usage.activities({
        ...query,
        kind: query.kind || undefined,
        q: query.q || undefined,
        limit: 50,
      }),
      params.get("verify") === "1" ? usage.verifyActivities() : Promise.resolve(undefined),
    ]);
    return html(
      200,
      activitiesPage({
        query,
        items: list.items,
        next: list.next,
        before: query.before,
        verify,
        notice,
      }),
    );
  }

  const trace = TRACE_PATH_RE.exec(pathname);
  const id = trace?.[1] ?? "";
  if (!EVENT_ID_RE.test(id)) return notFound();
  return traceResponse(usage, csrf, id, { notice });
}

export async function handleUsageDashboardGet(
  ctx: AppContext,
  deps: AppDeps,
  request: Request,
  signedIn: SignedIn,
): Promise<Response> {
  const url = new URL(request.url);
  const tab = tabOf(url.pathname);
  const usage = usageLedgerFor(ctx.env, deps, signedIn.account.id);
  if (!usage) {
    if (url.pathname === "/dashboard/usage/export") {
      return text(503, "The usage ledger is not configured on this server.");
    }
    return emptyTab(tab, LEDGER_MISSING);
  }
  const csrf = await csrfToken(ctx.sessionSecret, signedIn.session);
  try {
    return await renderGet(usage, url, signedIn.account, csrf);
  } catch (error) {
    logEvent("error", "usage_dashboard_failed", {
      user: signedIn.account.id,
      path: url.pathname,
      error: error instanceof Error ? error.name : "unknown",
    });
    return emptyTab(tab, LEDGER_FAILED, 503);
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Budget form fields as the ledger's budget input (validation happens in the ledger). */
function budgetInput(form: FormData): Record<string, unknown> {
  const period = field(form, "period");
  const reserve = field(form, "reserve_usd");
  const thresholds = field(form, "thresholds");
  const limit = field(form, "limit_usd");
  const input: Record<string, unknown> = {
    name: field(form, "name"),
    scope: field(form, "scope"),
    scopeValue: field(form, "scope_value") || undefined,
    period,
    limitUsd: limit === "" ? undefined : Number(limit),
    mode: field(form, "mode") || "alert",
    reserveUsd: reserve === "" ? null : Number(reserve),
    unknownPrice: field(form, "unknown_price") || "allow",
    thresholds:
      thresholds === ""
        ? undefined
        : thresholds
            .split(/[\s,;%]+/)
            .filter(Boolean)
            .map(Number),
  };
  if (period === "custom") {
    const start = field(form, "window_start");
    const end = field(form, "window_end");
    input.windowStart = /^\d{4}-\d{2}-\d{2}$/.test(start) ? Date.parse(start) : undefined;
    input.windowEnd = /^\d{4}-\d{2}-\d{2}$/.test(end) ? Date.parse(end) + DAY : undefined;
  }
  return input;
}

function budgetDraft(form: FormData): BudgetFormValues {
  const draft: BudgetFormValues = {};
  for (const name of BUDGET_FORM_FIELDS) draft[name] = field(form, name).slice(0, 200);
  return draft;
}

async function budgetPost(
  usage: AccountUsageStub,
  form: FormData,
  actor: string,
  csrf: string,
): Promise<Response> {
  const intent = field(form, "intent");
  if (intent === "delete" || intent === "update") {
    const id = field(form, "id");
    if (!BUDGET_ID_RE.test(id)) return redirect("/dashboard/budgets?notice=budget-not-found");
    if (intent === "delete") {
      const removed = await usage.deleteBudget(id, actor);
      return redirect(
        `/dashboard/budgets?notice=${removed ? "budget-deleted" : "budget-not-found"}`,
      );
    }
    const updated = await usage.updateBudget(id, budgetInput(form), actor);
    if (!updated.ok) {
      return budgetsResponse(usage, csrf, {
        status: 400,
        notice: { text: `Budget not saved: ${updated.error}.`, warn: true },
      });
    }
    return redirect(
      `/dashboard/budgets?notice=${updated.value ? "budget-updated" : "budget-not-found"}`,
    );
  }
  if (intent !== "create") return text(400, "Unknown budget action");
  const created = await usage.createBudget(budgetInput(form), actor);
  if (!created.ok) {
    return budgetsResponse(usage, csrf, {
      status: 400,
      notice: { text: `Budget not created: ${created.error}.`, warn: true },
      draft: budgetDraft(form),
    });
  }
  return redirect("/dashboard/budgets?notice=budget-created");
}

async function rateCardPost(
  usage: AccountUsageStub,
  form: FormData,
  actor: string,
  csrf: string,
): Promise<Response> {
  const raw = field(form, "entries");
  const fail = (message: string) =>
    budgetsResponse(usage, csrf, {
      status: 400,
      notice: { text: `Rate card not saved: ${message}.`, warn: true },
      rateCardDraft: raw.slice(0, MAX_RATE_CARD_TEXT),
    });
  if (raw.length > MAX_RATE_CARD_TEXT) return fail("the text is too long");
  let entries: unknown;
  try {
    entries = raw === "" ? [] : JSON.parse(raw);
  } catch {
    return fail("the text is not valid JSON");
  }
  const result = await usage.replaceRateCard(entries, actor);
  if (!result.ok) return fail(result.error);
  return redirect("/dashboard/budgets?notice=rate-card-saved");
}

async function balancesPost(
  ctx: AppContext,
  usage: AccountUsageStub,
  account: Account,
  actor: string,
): Promise<Response> {
  try {
    const keys = await ctx.accounts.providerKeys(account.id);
    const balances = await fetchProviderBalances(keys, ctx.fetch, Date.now());
    await usage.saveBalances(balances, actor);
    return redirect("/dashboard/overview?notice=balances-refreshed");
  } catch (error) {
    logEvent("warn", "balances_refresh_failed", {
      user: account.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return redirect("/dashboard/overview?notice=balances-failed");
  }
}

async function tracePost(
  usage: AccountUsageStub,
  form: FormData,
  id: string,
  action: string,
  actor: string,
  csrf: string,
): Promise<Response> {
  if (action === "debug-log") {
    const detail = await usage.event(id);
    if (!detail) return notFound();
    const debugLog = detail.hasDebugLog ? await usage.readDebugLog(id, actor) : null;
    return html(200, tracePage({ csrf, detail, debugLog }));
  }
  const amount = field(form, "amount_usd");
  const result = await usage.adjust(
    id,
    {
      kind: field(form, "kind"),
      amountUsd: amount === "" ? undefined : Number(amount),
      reason: field(form, "reason"),
    },
    actor,
  );
  if (!result.ok) {
    return traceResponse(usage, csrf, id, {
      status: 400,
      notice: { text: `Adjustment not added: ${result.error}.`, warn: true },
    });
  }
  if (!result.value) return notFound();
  return redirect(`/dashboard/traces/${id}?notice=adjusted`);
}

export async function handleUsageDashboardPost(
  ctx: AppContext,
  deps: AppDeps,
  signedIn: SignedIn,
  pathname: string,
  form: FormData,
): Promise<Response> {
  const { account } = signedIn;
  const usage = usageLedgerFor(ctx.env, deps, account.id);
  const tab = tabOf(pathname);
  if (!usage) return emptyTab(tab, LEDGER_MISSING, 503);
  const actor = `dashboard:${account.id}`;
  const csrf = await csrfToken(ctx.sessionSecret, signedIn.session);
  try {
    if (pathname === "/dashboard/balances/refresh")
      return await balancesPost(ctx, usage, account, actor);
    if (pathname === "/dashboard/budgets") return await budgetPost(usage, form, actor, csrf);
    if (pathname === "/dashboard/rate-card") return await rateCardPost(usage, form, actor, csrf);
    if (pathname === "/dashboard/debug-capture") {
      const enabled = field(form, "enabled") === "1";
      await usage.setDebugCapture(enabled, actor);
      return redirect(`/dashboard/budgets?notice=${enabled ? "debug-on" : "debug-off"}`);
    }
    const trace = TRACE_POST_RE.exec(pathname);
    const id = trace?.[1] ?? "";
    if (!EVENT_ID_RE.test(id)) return notFound();
    return await tracePost(usage, form, id, trace?.[2] ?? "", actor, csrf);
  } catch (error) {
    logEvent("error", "usage_dashboard_post_failed", {
      user: account.id,
      path: pathname,
      error: error instanceof Error ? error.name : "unknown",
    });
    return emptyTab(tab, LEDGER_FAILED, 503);
  }
}
