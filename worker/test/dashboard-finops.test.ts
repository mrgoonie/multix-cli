import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/config.js";
import type { AccountLedgerNamespace } from "../src/ledger/account-ledger.js";
import type { OperationInput } from "../src/ledger/ledger-types.js";
import { durationText, usdText } from "../src/pages/finops-format.js";
import { withoutCopyScript } from "./copy-script-helpers.js";
import { fakeLedgerNamespace, fakeNamespace, fakeQuotaNamespace } from "./fake-job-bindings.js";
import {
  type Browser,
  githubFetch,
  hiddenField,
  newBrowser,
  oauthEnv,
  signIn,
} from "./oauth-harness.js";

const OCTOCAT = { id: 583231, login: "octocat" };
const HUBOT = { id: 480938, login: "hubot" };
const A_ID = "gh-583231";
const B_ID = "gh-480938";
const GEMINI_KEY = "AIzaSy-dashboard-secret-key-0123456789";
const SHA = "ab".repeat(32);

const FINOPS_PAGES = [
  "/dashboard/overview",
  "/dashboard/usage",
  "/dashboard/budgets",
  "/dashboard/traces",
  "/dashboard/activity",
];

function operation(overrides: Partial<OperationInput> = {}): OperationInput {
  const now = Date.now();
  return {
    op_id: "op_known_cost",
    source: "mcp",
    client_id: "client-1",
    client_name: "Claude",
    project_id: null,
    trace_id: "trace-1",
    job_id: "job-1",
    history_id: null,
    command: "gemini generate",
    provider: "gemini",
    model: "gemini-2.5-flash-image",
    task: null,
    status: "succeeded",
    error_code: null,
    started_at: now - 60_000,
    finished_at: now - 48_000,
    duration_ms: 12_000,
    output_count: 1,
    output_bytes: 2048,
    tokens_input: 12,
    tokens_output: 1290,
    tokens_total: 1302,
    tokens_thinking: null,
    credits: null,
    credits_unit: null,
    estimated_cost_usd: null,
    actual_cost_usd: 0.039,
    cost_provenance: "provider_reported",
    rate_source: null,
    http_requests: 2,
    http_errors: 0,
    detail: {
      provider_ids: ["resp_abc123"],
      outputs: [{ bytes: 2048, mime: "image/png", sha256: SHA }],
      spans: [
        { name: "inputs", start: now - 60_000, end: now - 59_500 },
        { name: "cli", start: now - 59_500, end: now - 50_000 },
        { name: "uploads", start: now - 50_000, end: now - 48_500 },
        { name: "finish", start: now - 48_500, end: now - 48_000 },
      ],
      metrics: { images: 1 },
    },
    ...overrides,
  };
}

async function setup(options: { ledger?: boolean } = {}) {
  const ledger = options.ledger === false ? undefined : await fakeLedgerNamespace();
  const jobs = fakeNamespace(ledger?.namespace);
  const env: WorkerEnv = oauthEnv({
    MULTIX_ALLOWED_USERS: "octocat,hubot",
    MULTIX_JOBS: jobs.namespace,
    MULTIX_JOB_QUOTA: fakeQuotaNamespace(),
    ...(ledger ? { MULTIX_LEDGER: ledger.namespace } : {}),
  });
  const a = newBrowser(env, githubFetch(OCTOCAT).fetch);
  const b = newBrowser(env, githubFetch(HUBOT).fetch);
  await signIn(a);
  await signIn(b);
  return { env, a, b, ledger: ledger?.namespace };
}

async function pageText(browser: Browser, path: string) {
  const response = await browser.request(path);
  return { status: response.status, text: await response.text(), response };
}

async function csrfOf(browser: Browser, path = "/dashboard"): Promise<string> {
  return hiddenField((await pageText(browser, path)).text, "csrf");
}

async function seed(ledger: AccountLedgerNamespace) {
  const stub = ledger.getByName(A_ID);
  await stub.recordFinish(operation());
  await stub.recordFinish(
    operation({
      op_id: "op_unknown_cost",
      provider: "openai",
      model: "gpt-image-1",
      actual_cost_usd: null,
      estimated_cost_usd: null,
      cost_provenance: "unknown",
      started_at: Date.now() - 30_000,
      detail: {},
    }),
  );
  await stub.recordFinish(
    operation({
      op_id: "op_failed",
      status: "failed",
      error_code: "provider_error",
      actual_cost_usd: null,
      estimated_cost_usd: 0.001,
      cost_provenance: "estimated",
      started_at: Date.now() - 20_000,
    }),
  );
}

/** Run one job through the REST API so the ledger gets a record the way production does. */
async function runRestJob(browser: Browser) {
  const created = await browser.post("/dashboard/api-keys", {
    csrf: await csrfOf(browser),
    name: "ci",
    intent: "create",
  });
  const match = /readonly value="(mxk_[A-Za-z0-9_-]{43})"/.exec(await created.text());
  if (!match?.[1]) throw new Error("no API key on the page");
  const response = await browser.request("/api/v1/jobs", {
    method: "POST",
    headers: { authorization: `Bearer ${match[1]}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "gemini generate", options: { prompt: "a secret prompt" } }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { job_id: string }).job_id;
}

describe("dashboard usage pages", () => {
  it("renders every page with tabs, and unknown cost as unknown rather than $0", async () => {
    const { a, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    const jobId = await runRestJob(a);

    const account = await pageText(a, "/dashboard");
    expect(account.text).toContain('href="/dashboard/usage"');
    expect(account.text).toContain('<a href="/dashboard" aria-current="page">Account</a>');

    for (const path of FINOPS_PAGES) {
      const { status, text, response } = await pageText(a, path);
      expect(status, path).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(text).toContain(`<a href="${path}" aria-current="page">`);
      expect(text).toContain('<main class="wide">');
      expect(withoutCopyScript(text)).not.toMatch(/<script/i);
    }

    const overview = (await pageText(a, "/dashboard/overview")).text;
    expect(overview).toContain("Operations with unknown cost");
    expect(overview).toContain("known cost above may be low");
    expect(overview).toContain("$0.04"); // 0.039 + 0.001
    expect(overview).toContain("op_failed");
    expect(overview).toContain('href="/dashboard/traces/op_failed"');

    const usage = (await pageText(a, "/dashboard/usage")).text;
    expect(usage).toContain('<svg class="chart"');
    expect(usage).toContain('<title id="chart-title">');
    expect(usage).toContain("Daily numbers as a table");
    // The openai group has only an unknown-cost operation: unknown is counted, not priced at $0.
    const openaiRow = /<tr><td>openai<\/td>.*?<\/tr>/.exec(usage)?.[0] ?? "";
    expect(openaiRow).toContain('<span class="muted">unknown</span>');
    expect(openaiRow).not.toContain("$0.00");

    const unknownTrace = (await pageText(a, "/dashboard/traces/op_unknown_cost")).text;
    expect(unknownTrace).toMatch(
      /Provider-reported cost<\/dt><dd><span class="muted">unknown<\/span>/,
    );
    expect(unknownTrace).toMatch(/Estimated cost<\/dt><dd><span class="muted">unknown<\/span>/);
    expect(unknownTrace).toContain('<span class="badge">unknown</span>');
    expect(unknownTrace).not.toContain("$0.00");

    const traces = (await pageText(a, "/dashboard/traces")).text;
    expect(traces).toContain(jobId);
    for (const id of ["op_known_cost", "op_unknown_cost", "op_failed"])
      expect(traces).toContain(id);
    expect(traces).not.toContain("a secret prompt");

    const activity = (await pageText(a, "/dashboard/activity")).text;
    expect(activity).toContain("<code>api_key.created</code>");
    expect(activity).not.toMatch(/mxk_[A-Za-z0-9_-]{43}/);
  });

  it("shows a trace waterfall, outputs, provider ids, metrics and provenance", async () => {
    const { a, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    const { status, text } = await pageText(a, "/dashboard/traces/op_known_cost");
    expect(status).toBe(200);
    for (const span of ["inputs", "cli", "uploads", "finish"]) {
      expect(text).toContain(`<span class="mono">${span}</span>`);
    }
    expect(text).toContain("9.50 s"); // cli span
    expect(text).toContain("500 ms");
    expect(text).toContain(`title="${SHA}">${SHA.slice(0, 12)}…`);
    expect(text).toContain("image/png");
    expect(text).toContain("resp_abc123");
    expect(text).toContain('<span class="mono">images</span>');
    expect(text).toContain('<span class="badge ok">provider reported</span>');
    expect(text).toContain("$0.039 USD");
  });

  it("pages traces with a cursor and filters by status", async () => {
    const { a, ledger } = await setup();
    const stub = (ledger as AccountLedgerNamespace).getByName(A_ID);
    const now = Date.now();
    for (let i = 0; i < 55; i++) {
      await stub.recordFinish(
        operation({ op_id: `op_${String(i).padStart(3, "0")}`, started_at: now - i * 1000 }),
      );
    }
    const first = (await pageText(a, "/dashboard/traces")).text;
    expect(first).toContain("op_000");
    expect(first).not.toContain("op_054");
    const older = /href="\/dashboard\/traces\?([^"]+)">Older operations/.exec(first)?.[1];
    expect(older).toBeTruthy();
    const second = (
      await pageText(a, `/dashboard/traces?${(older ?? "").replaceAll("&#38;", "&")}`)
    ).text;
    expect(second).toContain("op_054");
    expect(second).not.toContain("op_000<");

    const failedOnly = (await pageText(a, "/dashboard/traces?status=failed")).text;
    expect(failedOnly).toContain("No operations match.");
    const bad = await pageText(a, "/dashboard/traces?cursor=%3Cscript%3E");
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("<script>");
  });

  it("answers 404 for unknown, malformed and other accounts' operation ids", async () => {
    const { a, b, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    await (ledger as AccountLedgerNamespace)
      .getByName(B_ID)
      .recordActivity({ actor: "user:x", kind: "test.b_only", subject: "b-subject", metadata: {} });

    expect((await pageText(a, "/dashboard/traces/op_known_cost")).status).toBe(200);
    expect((await pageText(b, "/dashboard/traces/op_known_cost")).status).toBe(404);
    expect((await pageText(a, "/dashboard/traces/nope")).status).toBe(404);
    expect((await pageText(a, `/dashboard/traces/${"x".repeat(129)}`)).status).toBe(404);
    expect((await pageText(a, "/dashboard/traces/a%3Cb")).status).toBe(404);

    for (const path of FINOPS_PAGES) {
      const { text } = await pageText(b, path);
      expect(text, path).not.toContain("op_known_cost");
      expect(text, path).not.toContain("op_failed");
    }
    expect((await pageText(a, "/dashboard/activity")).text).not.toContain("b_only");
    expect((await pageText(b, "/dashboard/activity")).text).toContain("b_only");
  });

  it("requires a session", async () => {
    const { env } = await setup();
    const anonymous = newBrowser(env, githubFetch(OCTOCAT).fetch);
    for (const path of [...FINOPS_PAGES, "/dashboard/usage/export?format=csv"]) {
      const response = await anonymous.request(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
    }
  });
});

describe("dashboard usage filters and export", () => {
  it("filters, rejects bad filters, and exports CSV and JSON with the same filters", async () => {
    const { a, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    const filtered = (await pageText(a, "/dashboard/usage?provider=openai&group_by=model")).text;
    expect(filtered).toContain("Breakdown by model");
    expect(filtered).toContain("gpt-image-1");
    expect(filtered).not.toContain("gemini-2.5-flash-image");
    expect(filtered).toContain("/dashboard/usage/export?format=csv&#38;provider=openai");

    const bad = await pageText(a, "/dashboard/usage?provider=%3Cimg%20src%3Dx%3E");
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("provider is not a valid value");
    expect(bad.text).not.toContain("<img src=x>");
    expect(bad.text).toContain("&#60;img src=x&#62;");

    const csv = await a.request("/dashboard/usage/export?format=csv&provider=openai");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toMatch(
      /^attachment; filename="multix-usage-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csv.headers.get("cache-control")).toBe("no-store");
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines[0]?.startsWith("op_id,started_at")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("op_unknown_cost");

    const json = await a.request("/dashboard/usage/export?format=json");
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(json.headers.get("content-disposition")).toMatch(/\.json"$/);
    const exported = (await json.json()) as { truncated: boolean; operations: { op_id: string }[] };
    expect(exported.truncated).toBe(false);
    expect(exported.operations.map((o) => o.op_id).sort()).toEqual([
      "op_failed",
      "op_known_cost",
      "op_unknown_cost",
    ]);
    expect((await a.request("/dashboard/usage/export?format=xml")).status).toBe(400);

    const activity = (await pageText(a, "/dashboard/activity?kind=usage.exported")).text;
    expect(activity.match(/<code>usage\.exported<\/code>/g)).toHaveLength(2);
    expect(activity).toContain("format=csv");
    expect(activity).toContain("user:gh-583231");
  });

  it("deletes all usage data only after DELETE is typed, with a valid CSRF token", async () => {
    const { a, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    const csrf = await csrfOf(a, "/dashboard/usage");

    expect(
      (await a.post("/dashboard/usage/delete", { csrf: "bad", confirm: "DELETE" })).status,
    ).toBe(403);
    expect((await a.post("/dashboard/usage/delete", { confirm: "DELETE" })).status).toBe(403);
    expect(
      (await a.post("/dashboard/usage/delete", { csrf, confirm: "DELETE" }, "https://evil.example"))
        .status,
    ).toBe(403);
    const unconfirmed = await a.post("/dashboard/usage/delete", { csrf, confirm: "delete" });
    expect(unconfirmed.headers.get("location")).toBe("/dashboard/usage?notice=delete-confirm");
    expect((await pageText(a, "/dashboard/traces")).text).toContain("op_known_cost");

    const deleted = await a.post("/dashboard/usage/delete", { csrf, confirm: "DELETE" });
    expect(deleted.headers.get("location")).toBe("/dashboard/usage?notice=usage-deleted");
    expect((await pageText(a, "/dashboard/traces")).text).not.toContain("op_known_cost");
    expect((await pageText(a, "/dashboard/activity")).text).toContain("ledger.deleted");
  });
});

describe("dashboard budgets", () => {
  it("creates, edits and deletes a budget, with CSRF required and validation errors shown", async () => {
    const { a, b, ledger } = await setup();
    await seed(ledger as AccountLedgerNamespace);
    const csrf = await csrfOf(a, "/dashboard/budgets");
    const form = {
      csrf,
      name: "Gemini monthly",
      scope_kind: "provider",
      scope_value: "gemini",
      period: "month",
      limit_usd: "0.05",
      thresholds: "50, 80, 100",
    };

    expect((await a.post("/dashboard/budgets", { ...form, csrf: "wrong" })).status).toBe(403);
    expect((await a.post("/dashboard/budgets", { ...form, csrf: "" })).status).toBe(403);
    expect((await (ledger as AccountLedgerNamespace).getByName(A_ID).budgetStatuses()).length).toBe(
      0,
    );

    const invalid = await a.post("/dashboard/budgets", {
      ...form,
      limit_usd: "-3",
      name: "<b>x</b>",
    });
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("Budget not created: limit_usd must be a number greater than 0");
    expect(invalidText).toContain('value="&#60;b&#62;x&#60;/b&#62;"');
    expect(invalidText).not.toContain("<b>x</b>");
    const badThresholds = await a.post("/dashboard/budgets", { ...form, thresholds: "50, abc" });
    expect(await badThresholds.text()).toContain("thresholds must be");

    const created = await a.post("/dashboard/budgets", form);
    expect(created.headers.get("location")).toBe("/dashboard/budgets?notice=budget-created");
    const [budget] = await (ledger as AccountLedgerNamespace).getByName(A_ID).budgetStatuses();
    expect(budget).toMatchObject({
      name: "Gemini monthly",
      limit_usd: 0.05,
      thresholds: [50, 80, 100],
    });
    const id = budget?.id ?? "";

    const page = (await pageText(a, "/dashboard/budgets?notice=budget-created")).text;
    expect(page).toContain("Budget created.");
    expect(page).toContain("do not block or stop jobs");
    expect(page).toContain('<span class="state warning">warning</span>'); // 0.039 + 0.001 of 0.05 = 80%
    expect(page).toContain("Alerts raised this period: 50%, 80%");
    expect(page).toContain(`action="/dashboard/budgets/${id}"`);
    expect(page).toContain("Forecast for the period");

    // Another account cannot touch it: B's ledger has no such budget.
    const csrfB = await csrfOf(b, "/dashboard/budgets");
    const foreign = await b.post(`/dashboard/budgets/${id}/delete`, { csrf: csrfB });
    expect(foreign.headers.get("location")).toBe("/dashboard/budgets?notice=budget-not-found");

    const badEdit = await a.post(`/dashboard/budgets/${id}`, { ...form, period: "year" });
    expect(badEdit.status).toBe(400);
    expect(await badEdit.text()).toContain(
      "Budget not saved: period must be one of: day, week, month",
    );
    const edited = await a.post(`/dashboard/budgets/${id}`, {
      ...form,
      limit_usd: "10",
      name: "Gemini",
    });
    expect(edited.headers.get("location")).toBe("/dashboard/budgets?notice=budget-saved");
    const editedPage = (await pageText(a, "/dashboard/budgets")).text;
    expect(editedPage).toContain('<span class="state ok">ok</span>');
    expect(editedPage).toContain("$10.00 USD");

    expect((await a.post(`/dashboard/budgets/${id}/delete`, { csrf: "x" })).status).toBe(403);
    const removed = await a.post(`/dashboard/budgets/${id}/delete`, { csrf });
    expect(removed.headers.get("location")).toBe("/dashboard/budgets?notice=budget-deleted");
    expect((await pageText(a, "/dashboard/budgets")).text).toContain("No budgets yet.");
    const again = await a.post(`/dashboard/budgets/${id}/delete`, { csrf });
    expect(again.headers.get("location")).toBe("/dashboard/budgets?notice=budget-not-found");
  });
});

describe("dashboard activity", () => {
  it("records sign-in and provider key changes without the key value, and verifies the chain", async () => {
    const { a } = await setup();
    const csrf = await csrfOf(a);
    await a.post("/dashboard/secrets", {
      csrf,
      name: "GEMINI_API_KEY",
      value: GEMINI_KEY,
      intent: "save",
    });
    await a.post("/dashboard/secrets", { csrf, name: "GEMINI_API_KEY", intent: "delete" });

    const { text } = await pageText(a, "/dashboard/activity");
    expect(text).toContain("<code>auth.signed_in</code>");
    expect(text).toContain("github_login=octocat");
    expect(text).toContain("<code>provider_key.saved</code>");
    expect(text).toContain("<code>provider_key.removed</code>");
    expect(text).toContain("<td>GEMINI_API_KEY</td>");
    expect(text).toContain("user:gh-583231");
    expect(text).toContain("Integrity check passed");
    expect(text).not.toContain(GEMINI_KEY);

    const searched = (await pageText(a, "/dashboard/activity?q=provider_key")).text;
    expect(searched).not.toContain("<code>auth.signed_in</code>");
    expect(searched).toContain("<code>provider_key.saved</code>");
    const byKind = (await pageText(a, "/dashboard/activity?kind=auth.")).text;
    expect(byKind).toContain("<code>auth.signed_in</code>");
    expect(byKind).not.toContain("<code>provider_key.saved</code>");
    const future = (await pageText(a, "/dashboard/activity?from=2999-01-01")).text;
    expect(future).toContain("No activity matches.");
    expect((await pageText(a, "/dashboard/activity?kind=%3Cx%3E")).status).toBe(400);
  });

  it("pages older entries and escapes metadata", async () => {
    const { a, ledger } = await setup();
    const stub = (ledger as AccountLedgerNamespace).getByName(A_ID);
    for (let i = 0; i < 55; i++) {
      await stub.recordActivity({
        actor: "user:test",
        kind: "test.bulk",
        subject: `s-${i}`,
        metadata: { note: i === 0 ? "<script>alert(1)</script>" : "ok" },
      });
    }
    const first = (await pageText(a, "/dashboard/activity")).text;
    expect(first).toContain("s-54");
    expect(first).not.toContain("<td>s-0</td>");
    const older = /href="\/dashboard\/activity\?([^"]+)">Older entries/.exec(first)?.[1] ?? "";
    expect(older).toContain("before=");
    const second = (await pageText(a, `/dashboard/activity?${older.replaceAll("&#38;", "&")}`))
      .text;
    expect(second).toContain("<td>s-0</td>");
    expect(second).not.toContain("<script>alert(1)</script>");
    expect(second).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
  });

  it("records sign-out", async () => {
    const { a, ledger } = await setup();
    await a.post("/dashboard/logout", { csrf: await csrfOf(a) });
    const page = await (ledger as AccountLedgerNamespace)
      .getByName(A_ID)
      .listActivities({ kind: "auth." }, 10);
    expect(page.activities.map((x) => x.kind)).toEqual(["auth.signed_out", "auth.signed_in"]);
  });
});

describe("dashboard without the usage ledger", () => {
  it("hides the usage tabs and answers a friendly page on the usage routes", async () => {
    const { a } = await setup({ ledger: false });
    const account = (await pageText(a, "/dashboard")).text;
    expect(account).not.toContain('href="/dashboard/usage"');
    for (const path of [
      ...FINOPS_PAGES,
      "/dashboard/traces/op_x",
      "/dashboard/usage/export?format=csv",
    ]) {
      const { status, text } = await pageText(a, path);
      expect(status, path).toBe(200);
      expect(text).toContain("Usage ledger not configured");
    }
    const csrf = await csrfOf(a);
    const post = await a.post("/dashboard/budgets", { csrf, name: "x" });
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Usage ledger not configured");
    // Account actions keep working without a ledger.
    const saved = await a.post("/dashboard/secrets", {
      csrf,
      name: "GEMINI_API_KEY",
      value: GEMINI_KEY,
      intent: "save",
    });
    expect(saved.headers.get("location")).toBe("/dashboard?notice=saved");
  });
});

describe("dashboard money and duration formatting", () => {
  it("rounds sensibly and keeps small amounts visible", () => {
    expect(usdText(0)).toBe("$0.00");
    expect(usdText(1234.5)).toBe("$1,234.50");
    expect(usdText(0.5)).toBe("$0.50");
    expect(usdText(0.012345)).toBe("$0.0123");
    expect(usdText(0.000042)).toBe("$0.000042");
    expect(usdText(-0.25)).toBe("-$0.25");
    expect(durationText(850)).toBe("850 ms");
    expect(durationText(12_345)).toBe("12.3 s");
    expect(durationText(125_000)).toBe("2m 05s");
  });
});
