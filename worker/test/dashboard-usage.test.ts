import { describe, expect, it } from "vitest";
import { money } from "../src/pages/usage-format.js";
import { CSV_COLUMNS } from "../src/usage/usage-queries.js";
import type { UsageService } from "../src/usage/usage-service.js";
import type { BeginInput, SettleInput } from "../src/usage/usage-types.js";
import { withoutCopyScript } from "./copy-script-helpers.js";
import {
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  newBrowser,
  oauthEnv,
  registerClient,
  signIn,
} from "./oauth-harness.js";
import { memoryUsageNamespace } from "./usage-sql.js";

const OCTOCAT = { id: 583231, login: "octocat" };
const USER_ID = "gh-583231";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let seq = 0;
const nextJobId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** One remote job from begin to settle; `cost` undefined leaves the provider cost unknown. */
function remoteJob(
  service: UsageService,
  at: number,
  over: { provider: string; model: string; client: string; source?: "mcp" | "rest"; cost?: number },
): string {
  const jobId = nextJobId();
  const begin: BeginInput = {
    jobId,
    source: over.source ?? "mcp",
    clientId: over.client,
    command: `${over.provider} image`,
    provider: over.provider,
    modelRequested: over.model,
    startedAt: at,
  };
  service.begin(begin);
  const settle: SettleInput = {
    jobId,
    status: "succeeded",
    createdAt: at,
    runningAt: at + 1_000,
    finishedAt: at + 30_000,
    exitCode: 0,
    outputs: [{ name: "image-1.png", bytes: 2048, stored: true }],
    timings: { inputsMs: 500, cliMs: 25_000, uploadMs: 1_500 },
    run: {
      command: `${over.provider} image`,
      provider: over.provider,
      model: over.model,
      ok: true,
      exitCode: 0,
      durationMs: 25_000,
      usage: over.cost === undefined ? undefined : { cost_usd: over.cost },
      http: { requests: 1, errors: 0, ms: 24_000 },
      providerIds: ["resp_1"],
      outputs: [{ name: "image-1.png", bytes: 2048, mime: "image/png", sha256: "b".repeat(64) }],
    },
  };
  service.settle(settle);
  return jobId;
}

/** Three providers, two MCP clients, a rate-card estimate, an unknown cost and a CLI import. */
function seed(service: UsageService): { unknownJob: string; paidJob: string } {
  const now = Date.now();
  service.replaceRateCard(
    [{ provider: "openai", model: "*", unit: "job", usd: 0.02, effective_from: "2026-01-01" }],
    "test",
  );
  const paidJob = remoteJob(service, now - 3 * HOUR, {
    provider: "gemini",
    model: "gemini-3-pro-image",
    client: "client-a",
    cost: 0.04,
  });
  remoteJob(service, now - 2 * DAY, {
    provider: "openai",
    model: "gpt-image-1",
    client: "client-b",
    source: "rest",
  });
  const unknownJob = remoteJob(service, now - 5 * DAY, {
    provider: "replicate",
    model: "flux-schnell",
    client: "client-a",
  });
  service.importCli(
    [
      {
        id: "h_cli1",
        ts: new Date(now - 4 * HOUR).toISOString(),
        duration_ms: 1200,
        command: "gemini image",
        provider: "gemini",
        model: "gemini-3-pro-image",
        ok: true,
        exit_code: 0,
        outputs: [{ ext: "png", bytes: 1000 }],
        usage: { cost_usd: 0.0123 },
      },
    ],
    "site",
    "test",
  );
  return { unknownJob, paidJob };
}

async function signedIn(options: { ledger?: boolean } = {}) {
  const usage = memoryUsageNamespace();
  const env = oauthEnv(options.ledger === false ? {} : { MULTIX_USAGE: usage.namespace });
  const github = githubFetch(OCTOCAT);
  const browser = newBrowser(env, github.fetch);
  await signIn(browser);
  const csrf = hiddenField(await (await browser.request("/dashboard")).text(), "csrf");
  return { env, browser, csrf, usage, service: usage.service(USER_ID) };
}

/** Text of a KPI tile's value. */
function tileValue(html: string, label: string): string {
  const match = new RegExp(`<div class="label">${label}</div><div class="value">(.*?)</div>`).exec(
    html,
  );
  return match?.[1] ?? "";
}

const TABS = [
  "/dashboard/overview",
  "/dashboard/usage",
  "/dashboard/budgets",
  "/dashboard/traces",
  "/dashboard/activities",
];

describe("usage dashboard pages", () => {
  it("renders every tab with the nav, the current tab marked and no new script", async () => {
    const { browser, service } = await signedIn();
    seed(service);
    for (const path of TABS) {
      const response = await browser.request(path);
      expect(response.status, path).toBe(200);
      const page = await response.text();
      expect(page).toContain(`<a href="${path}" aria-current="page">`);
      expect(page).toContain('<a href="/dashboard">Settings</a>');
      expect(withoutCopyScript(page)).not.toMatch(/<script|\son[a-z]+=/i);
    }
    const settings = await (await browser.request("/dashboard")).text();
    expect(settings).toContain('<a href="/dashboard" aria-current="page">Settings</a>');
  });

  it("shows the ledger's KPIs on the overview, with unknown cost never as $0", async () => {
    const { browser, service } = await signedIn();
    seed(service);
    const page = await (await browser.request("/dashboard/overview")).text();
    const now = Date.now();
    const kpis = service.summary({ from: now - 30 * DAY, to: now }).kpis;
    expect(kpis.jobs).toBe(4);
    expect(kpis.unknownCostRuns).toBe(1);
    expect(tileValue(page, "Known cost")).toBe(money(kpis.knownUsd));
    expect(money(kpis.knownUsd)).toBe("$0.0723");
    expect(tileValue(page, "Jobs")).toBe(String(kpis.jobs));
    expect(tileValue(page, "Unknown-cost runs")).toContain(`>${kpis.unknownCostRuns}<`);
    expect(page).toContain('role="img"');
    expect(page).toContain("<title");
    expect(page).toContain("Top models");
    expect(page).toContain("gemini-3-pro-image");
    expect(page).toContain('action="/dashboard/balances/refresh"');
  });

  it("lists runs with filters, marks estimates and unknown costs, and pages with Older", async () => {
    const { browser, service } = await signedIn();
    seed(service);
    const page = await (await browser.request("/dashboard/usage?range=7d")).text();
    expect(page).toContain('<option value="7d" selected>');
    expect(page).toContain(">unknown</span>");
    expect(page).toContain(">est.</span>");
    expect(page).toContain("$0.0400");
    for (const dim of ["By provider", "By model", "By client", "By status"]) {
      expect(page).toContain(dim);
    }
    expect(page).toContain("client-a");
    expect(page).toContain("client-b");
    expect(page).toContain("/dashboard/usage/export?format=csv&#38;from=");

    const filtered = await (await browser.request("/dashboard/usage?provider=openai")).text();
    expect(tileValue(filtered, "Jobs")).toBe("1");

    for (let i = 0; i < 55; i++) {
      remoteJob(service, Date.now() - 6 * DAY + i, {
        provider: "gemini",
        model: "m",
        client: "client-a",
        cost: 0.01,
      });
    }
    const first = await (await browser.request("/dashboard/traces")).text();
    const older = /href="(\/dashboard\/traces\?[^"]*cursor=[^"]+)" rel="next"/.exec(first)?.[1];
    expect(older).toBeTruthy();
    const second = await browser.request((older ?? "").replaceAll("&#38;", "&"));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain(">Newest</a>");
  });

  it("reports a bad filter instead of failing", async () => {
    const { browser } = await signedIn();
    const response = await browser.request(
      "/dashboard/usage?range=custom&from=2026-02-01&to=2025-01-01",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Filters not applied: from must be before to.");
  });

  it("exports the filtered runs as a CSV download", async () => {
    const { browser, service } = await signedIn();
    seed(service);
    const response = await browser.request("/dashboard/usage/export?format=csv&provider=gemini");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="multix-usage-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = (await response.text()).trim().split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(3);
    const json = await browser.request("/dashboard/usage/export?format=json");
    expect(((await json.json()) as { items: unknown[] }).items).toHaveLength(4);
    expect((await browser.request("/dashboard/usage/export?format=xml")).status).toBe(400);
    const kinds = service.activities({ kind: "usage.exported" }).items.map((a) => a.meta.format);
    expect(kinds.sort()).toEqual(["csv", "json"]);
  });

  it("asks a signed-out visitor to sign in", async () => {
    const usage = memoryUsageNamespace();
    const env = oauthEnv({ MULTIX_USAGE: usage.namespace });
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const response = await browser.request("/dashboard/usage");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  it("shows a notice instead of failing when the usage ledger is not bound", async () => {
    const { browser, csrf } = await signedIn({ ledger: false });
    for (const path of TABS) {
      const response = await browser.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toContain("usage ledger is not configured");
    }
    const post = await browser.post("/dashboard/budgets", { csrf, intent: "create" });
    expect(post.status).toBe(503);
    expect((await browser.request("/dashboard/usage/export?format=csv")).status).toBe(503);
  });
});

describe("usage dashboard traces", () => {
  it("shows a run's spans, facts and outputs", async () => {
    const { browser, service } = await signedIn();
    const { paidJob } = seed(service);
    const response = await browser.request(`/dashboard/traces/${paidJob}`);
    expect(response.status).toBe(200);
    const page = await response.text();
    for (const span of ["queue", "inputs", "cli", "upload"]) {
      expect(page).toContain(`>${span}</text>`);
    }
    expect(page).toMatch(/<svg [^>]*role="img"/);
    expect(page).toContain("gemini-3-pro-image");
    expect(page).toContain("resp_1");
    expect(page).toContain("b".repeat(64));
    expect(page).toContain("provider reported");
    expect(withoutCopyScript(page)).not.toMatch(/<script/i);
  });

  it("shows unknown cost as unknown and returns 404 for another account's or a malformed id", async () => {
    const { browser, service, usage } = await signedIn();
    const { unknownJob } = seed(service);
    const unknown = await (await browser.request(`/dashboard/traces/${unknownJob}`)).text();
    expect(unknown).toContain(">unknown</span>");
    expect(unknown).not.toMatch(/cost \$0\.00/);

    const foreign = remoteJob(usage.service("gh-999"), Date.now() - HOUR, {
      provider: "gemini",
      model: "m",
      client: "c",
      cost: 1,
    });
    expect(usage.service("gh-999").event(foreign)).not.toBeNull();
    expect((await browser.request(`/dashboard/traces/${foreign}`)).status).toBe(404);
    expect((await browser.request("/dashboard/traces/bad%20id")).status).toBe(404);
    expect((await browser.request(`/dashboard/traces/${"x".repeat(129)}`)).status).toBe(404);
  });

  it("adds an adjustment and shows a validation error from the ledger", async () => {
    const { browser, csrf, service } = await signedIn();
    const { paidJob } = seed(service);
    const added = await browser.post(`/dashboard/traces/${paidJob}/adjustments`, {
      csrf,
      kind: "refund",
      amount_usd: "0.01",
      reason: "Refund for a blurry image",
    });
    expect(added.headers.get("location")).toBe(`/dashboard/traces/${paidJob}?notice=adjusted`);
    expect(service.event(paidJob)?.adjustments).toHaveLength(1);
    const rejected = await browser.post(`/dashboard/traces/${paidJob}/adjustments`, {
      csrf,
      kind: "refund",
      amount_usd: "0.01",
      reason: "",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(
      "Adjustment not added: reason must be 1 to 200 characters.",
    );
  });

  it("shows a captured debug log on POST and records the view", async () => {
    const { browser, csrf, service } = await signedIn();
    const on = await browser.post("/dashboard/debug-capture", { csrf, enabled: "1" });
    expect(on.headers.get("location")).toBe("/dashboard/budgets?notice=debug-on");
    const jobId = nextJobId();
    const at = Date.now() - HOUR;
    service.begin({
      jobId,
      source: "mcp",
      command: "gemini image",
      provider: "gemini",
      startedAt: at,
    });
    service.settle({
      jobId,
      status: "failed",
      createdAt: at,
      finishedAt: at + 5_000,
      exitCode: 1,
      outputs: [],
      stderrTail: "Error: <quota exceeded>",
    });
    const trace = await (await browser.request(`/dashboard/traces/${jobId}`)).text();
    expect(trace).toContain("Show debug log");
    expect(trace).not.toContain("quota exceeded");
    const shown = await browser.post(`/dashboard/traces/${jobId}/debug-log`, { csrf });
    const page = await shown.text();
    expect(page).toContain("&#60;quota exceeded&#62;");
    expect(service.activities({ kind: "debug_log.viewed" }).items).toHaveLength(1);
  });
});

describe("usage dashboard budgets", () => {
  it("creates, edits and deletes a budget", async () => {
    const { browser, csrf, service } = await signedIn();
    const created = await browser.post("/dashboard/budgets", {
      csrf,
      intent: "create",
      name: "Gemini monthly",
      scope: "provider",
      scope_value: "gemini",
      period: "month",
      limit_usd: "25",
      mode: "block",
      reserve_usd: "0.5",
      unknown_price: "block",
      thresholds: "50, 90",
    });
    expect(created.headers.get("location")).toBe("/dashboard/budgets?notice=budget-created");
    const [status] = service.budgets();
    expect(status?.budget).toMatchObject({
      name: "Gemini monthly",
      scope: "provider",
      scopeValue: "gemini",
      limitUsd: 25,
      mode: "block",
      reserveUsd: 0.5,
      unknownPrice: "block",
      thresholds: [50, 90],
    });
    const id = status?.budget.id ?? "";
    const page = await (await browser.request("/dashboard/budgets")).text();
    expect(page).toContain("Gemini monthly");
    expect(page).toContain(
      "Blocking budgets only stop jobs Multix starts (MCP and REST). They cannot stop spend made directly with a provider or by local CLI runs.",
    );

    const updated = await browser.post("/dashboard/budgets", {
      csrf,
      intent: "update",
      id,
      name: "Gemini monthly",
      scope: "provider",
      scope_value: "gemini",
      period: "month",
      limit_usd: "40",
      mode: "alert",
      reserve_usd: "",
      unknown_price: "allow",
      thresholds: "80",
    });
    expect(updated.headers.get("location")).toBe("/dashboard/budgets?notice=budget-updated");
    expect(service.budgets()[0]?.budget).toMatchObject({
      limitUsd: 40,
      mode: "alert",
      reserveUsd: null,
    });

    const deleted = await browser.post("/dashboard/budgets", { csrf, intent: "delete", id });
    expect(deleted.headers.get("location")).toBe("/dashboard/budgets?notice=budget-deleted");
    expect(service.budgets()).toHaveLength(0);
  });

  it("shows the ledger's validation error and keeps the typed values", async () => {
    const { browser, csrf, service } = await signedIn();
    const response = await browser.post("/dashboard/budgets", {
      csrf,
      intent: "create",
      name: "Too small <b>",
      scope: "account",
      period: "month",
      limit_usd: "0",
      mode: "alert",
      unknown_price: "allow",
    });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("Budget not created: limitUsd must be a number from 0.01 to 1000000.");
    expect(page).toContain('value="Too small &#60;b&#62;"');
    expect(service.budgets()).toHaveLength(0);
  });

  it("replaces the rate card from JSON and rejects invalid entries", async () => {
    const { browser, csrf, service } = await signedIn();
    const entries = JSON.stringify([
      { provider: "gemini", model: "*", unit: "output", usd: 0.03, effective_from: "2026-01-01" },
    ]);
    const saved = await browser.post("/dashboard/rate-card", { csrf, entries });
    expect(saved.headers.get("location")).toBe("/dashboard/budgets?notice=rate-card-saved");
    expect(service.rateCard()).toHaveLength(1);
    const bad = await browser.post("/dashboard/rate-card", { csrf, entries: "[{" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Rate card not saved: the text is not valid JSON.");
    const invalid = await browser.post("/dashboard/rate-card", {
      csrf,
      entries: JSON.stringify([
        { provider: "gemini", unit: "litre", usd: 1, effective_from: "2026-01-01" },
      ]),
    });
    expect(invalid.status).toBe(400);
    expect(service.rateCard()).toHaveLength(1);
  });

  it("refuses POSTs without the CSRF token or from another origin", async () => {
    const { browser, csrf, service } = await signedIn();
    const form = { intent: "create", name: "x", scope: "account", period: "month", limit_usd: "5" };
    for (const path of [
      "/dashboard/budgets",
      "/dashboard/rate-card",
      "/dashboard/debug-capture",
      "/dashboard/balances/refresh",
      "/dashboard/traces/abc/adjustments",
      "/dashboard/traces/abc/debug-log",
    ]) {
      expect((await browser.post(path, form)).status, path).toBe(403);
      expect((await browser.post(path, { ...form, csrf: "wrong" })).status, path).toBe(403);
      expect(
        (await browser.post(path, { ...form, csrf }, "https://evil.example")).status,
        path,
      ).toBe(403);
    }
    expect(service.budgets()).toHaveLength(0);
    expect(service.debugCaptureUntil()).toBe(0);
  });
});

describe("usage dashboard activities", () => {
  it("records key and sign-in changes without key values and verifies the chain", async () => {
    const { browser, csrf, service } = await signedIn();
    const value = "AIzaSy-gemini-key-value-0123456789";
    await browser.post("/dashboard/secrets", {
      csrf,
      name: "GEMINI_API_KEY",
      value,
      intent: "save",
    });
    const created = await browser.post("/dashboard/api-keys", {
      csrf,
      name: "ci",
      intent: "create",
    });
    const apiKey = /readonly value="(mxk_[^"]+)"/.exec(await created.text())?.[1] ?? "";
    expect(apiKey).not.toBe("");
    await browser.post("/dashboard/secrets", { csrf, name: "GEMINI_API_KEY", intent: "delete" });

    const all = service.activities({}).items;
    const kinds = all.map((a) => a.kind);
    expect(kinds).toContain("auth.sign_in");
    expect(kinds).toContain("provider_key.saved");
    expect(kinds).toContain("provider_key.removed");
    expect(kinds).toContain("api_key.created");
    const saved = all.find((a) => a.kind === "provider_key.saved");
    expect(saved).toMatchObject({ actor: `dashboard:${USER_ID}`, target: "GEMINI_API_KEY" });
    const apiKeyActivity = all.find((a) => a.kind === "api_key.created" && a.meta.name === "ci");
    expect(apiKeyActivity?.target).toMatch(/^[0-9a-f-]{36}$/);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain(value);
    expect(dump).not.toContain(apiKey);

    const page = await (await browser.request("/dashboard/activities?kind=provider_key.")).text();
    expect(page).toContain("provider_key.saved");
    expect(page).not.toContain(">api_key.created<");
    const verified = await (await browser.request("/dashboard/activities?verify=1")).text();
    expect(verified).toContain("Chain intact");
  });

  it("records an MCP client connecting and being disconnected", async () => {
    const { browser, csrf, service } = await signedIn();
    const clientId = await registerClient(browser, "Claude <Desktop>");
    await authorizeAndGetToken(browser, clientId);
    const connected = service.activities({ kind: "client.connected" }).items[0];
    expect(connected).toMatchObject({
      actor: `dashboard:${USER_ID}`,
      target: clientId,
      meta: { name: "Claude <Desktop>" },
    });
    const dashboard = await (await browser.request("/dashboard")).text();
    const grantId = hiddenField(dashboard, "grant_id");
    await browser.post("/dashboard/connections/revoke", { csrf, grant_id: grantId });
    expect(service.activities({ kind: "client.disconnected" }).items[0]?.target).toBe(clientId);
    const page = await (await browser.request("/dashboard/activities?kind=client.")).text();
    expect(page).toContain("name=Claude &#60;Desktop&#62;");
  });

  it("pages with Older and records sign-out", async () => {
    const { browser, csrf, service } = await signedIn();
    for (let i = 0; i < 60; i++) {
      service.recordActivity({ actor: "system", kind: "budget.alert", target: `b${i}` });
    }
    const first = await (await browser.request("/dashboard/activities")).text();
    const older = /href="(\/dashboard\/activities\?[^"]*before=\d+)" rel="next"/.exec(first)?.[1];
    expect(older).toBeTruthy();
    const second = await (await browser.request((older ?? "").replaceAll("&#38;", "&"))).text();
    expect(second).toContain(">Newest</a>");
    await browser.post("/dashboard/logout", { csrf });
    expect(service.activities({ kind: "auth." }).items.map((a) => a.kind)).toContain(
      "auth.sign_out",
    );
  });
});

describe("money formatting", () => {
  it("keeps four significant decimals under a dollar", () => {
    expect(money(0.04)).toBe("$0.0400");
    expect(money(0.00012)).toBe("$0.00012");
    expect(money(0)).toBe("$0.00");
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-0.5)).toBe("-$0.5000");
  });
});
