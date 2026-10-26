import { describe, expect, it } from "vitest";
import type { CliImportEntry } from "../src/usage/usage-types.js";
import { fakeNamespace, fakeQuotaNamespace } from "./fake-job-bindings.js";
import { jsonResponse, route } from "./helpers.js";
import {
  type Browser,
  githubFetch,
  hiddenField,
  newBrowser,
  oauthEnv,
  signIn,
} from "./oauth-harness.js";
import { memoryUsageNamespace } from "./usage-sql.js";

// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies are untyped in tests
type Json = any;

const OCTOCAT = { id: 1, login: "octocat" };
const HUBOT = { id: 2, login: "hubot" };
const HOUR = 3_600_000;
const OPENROUTER_KEY = "sk-or-v1-secret-value-0123456789";
const ELEVENLABS_KEY = "sk_elevenlabs_secret_value_0123";
const GEMINI_KEY = "AIza-gemini-secret-value-1234";

const body = (response: Response): Promise<Json> => response.json();

async function createApiKey(browser: Browser, name = "ci"): Promise<string> {
  const dashboard = await (await browser.request("/dashboard")).text();
  const created = await browser.post("/dashboard/api-keys", {
    csrf: hiddenField(dashboard, "csrf"),
    name,
    intent: "create",
  });
  const match = /id="new-api-key-value" readonly value="(mxk_[A-Za-z0-9_-]{43})"/.exec(
    await created.text(),
  );
  if (!match?.[1]) throw new Error("no new key on the page");
  return match[1];
}

function api(browser: Browser, key: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  return browser.request(`/api/v1${path}`, { ...init, headers });
}

const post = (browser: Browser, key: string, path: string, payload: unknown, method = "POST") =>
  api(browser, key, path, { method, body: JSON.stringify(payload) });

/** Mocked provider balance endpoints: OpenRouter answers, ElevenLabs refuses the key. */
const balanceRoutes = [
  route("GET", /^https:\/\/openrouter\.ai\/api\/v1\/credits$/, () =>
    jsonResponse({ data: { total_credits: 20, total_usage: 5 } }),
  ),
  route("GET", /^https:\/\/api\.elevenlabs\.io\/v1\/user\/subscription$/, () =>
    jsonResponse({ detail: `bad key ${ELEVENLABS_KEY}` }, 401),
  ),
];

interface Account {
  browser: Browser;
  key: string;
  keyId: string;
}

/** Two allowlisted accounts sharing one in-memory usage namespace. */
async function setup(overrides = {}) {
  const usage = memoryUsageNamespace();
  const env = oauthEnv({
    MULTIX_ALLOWED_USERS: "octocat,hubot",
    MULTIX_USAGE: usage.namespace,
    ...overrides,
  });
  const account = async (user: typeof OCTOCAT): Promise<Account> => {
    const browser = newBrowser(env, githubFetch(user, ...balanceRoutes).fetch);
    await signIn(browser);
    const key = await createApiKey(browser);
    const keyId = (await body(await api(browser, key, "/me"))).api_key_id as string;
    return { browser, key, keyId };
  };
  return { usage, env, a: await account(OCTOCAT), account };
}

let seq = 0;
function entry(overrides: Partial<CliImportEntry> = {}): CliImportEntry {
  seq++;
  return {
    id: `h_test${seq}_${"x".repeat(20)}`,
    ts: new Date(Date.now() - HOUR).toISOString(),
    duration_ms: 1200,
    version: "1.0.0",
    command: "gemini image",
    provider: "gemini",
    model: "gemini-2.5-flash-image",
    ok: true,
    exit_code: 0,
    outputs: [{ ext: "png", bytes: 2048, mime: "image/png" }],
    usage: { cost_usd: 0.04, tokens: { input: 10, output: 20 } },
    provider_ids: ["req-123"],
    ...overrides,
  };
}

describe("usage import", () => {
  it("accepts the CLI sync shape, counts a replay as duplicates and lists rejected entries", async () => {
    const { usage, a } = await setup();
    const entries = [entry(), entry({ ok: false, exit_code: 1, error_code: "PROVIDER_ERROR" })];
    const bad = { ...entry(), id: "not-a-history-id" };
    const first = await post(a.browser, a.key, "/usage/import", {
      entries: [...entries, bad],
      project: "website",
    });
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [{ id: "not-a-history-id", reason: "invalid id" }],
    });

    const replay = await post(a.browser, a.key, "/usage/import", { entries });
    expect(await body(replay)).toEqual({ accepted: 0, duplicates: 2, rejected: [] });

    const imported = await usage.service("gh-1").activities({ kind: "usage.imported" });
    expect(imported.items).toHaveLength(1);
    expect(imported.items[0]).toMatchObject({ actor: `api_key:${a.keyId}` });
    const events = await body(await api(a.browser, a.key, "/usage/events?project=website"));
    expect(events.items).toHaveLength(2);
    expect(events.items[0]).toMatchObject({ source: "cli", project: "website" });
  });

  it("takes a full sync batch above the default body limit and rejects malformed bodies", async () => {
    const { a } = await setup();
    const batch = Array.from({ length: 500 }, () => entry());
    const payload = JSON.stringify({ entries: batch });
    expect(payload.length).toBeGreaterThan(64 * 1024);
    const big = await api(a.browser, a.key, "/usage/import", { method: "POST", body: payload });
    expect(big.status).toBe(200);
    expect((await body(big)).accepted).toBe(500);

    const tooMany = await post(a.browser, a.key, "/usage/import", {
      entries: [...batch, entry()],
    });
    expect(tooMany.status).toBe(400);
    for (const bad of [{}, { entries: "x" }, { entries: [], project: "no spaces" }]) {
      const response = await post(a.browser, a.key, "/usage/import", bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await body(response)).toMatchObject({ error: { code: "bad_request" } });
    }
  });
});

describe("usage reads", () => {
  it("serves the summary, event pages, one event and adjustments", async () => {
    const { a } = await setup();
    await post(a.browser, a.key, "/usage/import", {
      entries: [entry(), entry({ provider: "openai", command: "openai image" })],
    });
    const summary = await body(await api(a.browser, a.key, "/usage/summary?tz=420"));
    expect(summary.tzOffsetMinutes).toBe(420);
    expect(summary.kpis.jobs).toBe(2);
    expect(summary.breakdown.provider.map((r: Json) => r.key).sort()).toEqual(["gemini", "openai"]);

    const page1 = await body(await api(a.browser, a.key, "/usage/events?limit=1"));
    expect(page1.items).toHaveLength(1);
    expect(page1.next).toEqual(expect.any(String));
    const page2 = await body(
      await api(a.browser, a.key, `/usage/events?limit=1&cursor=${encodeURIComponent(page1.next)}`),
    );
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.next).toBeNull();

    const id = page1.items[0].id;
    const detail = await body(await api(a.browser, a.key, `/usage/events/${id}`));
    expect(detail).toMatchObject({ event: { id }, adjustments: [], hasDebugLog: false });
    expect((await api(a.browser, a.key, "/usage/events/cli_h_missing")).status).toBe(404);

    const adjusted = await post(a.browser, a.key, `/usage/events/${id}/adjustments`, {
      kind: "refund",
      amountUsd: 0.01,
      reason: "partial refund",
    });
    expect(adjusted.status).toBe(201);
    expect(await body(adjusted)).toMatchObject({ eventId: id, kind: "refund", amountUsd: -0.01 });
    const invalid = await post(a.browser, a.key, `/usage/events/${id}/adjustments`, {
      kind: "gift",
      amountUsd: 1,
      reason: "x",
    });
    expect(invalid.status).toBe(400);
    const missing = await post(a.browser, a.key, "/usage/events/cli_h_missing/adjustments", {
      kind: "refund",
      amountUsd: 1,
      reason: "x",
    });
    expect(missing.status).toBe(404);
  });

  it("rejects invalid filters with 400", async () => {
    const { a } = await setup();
    for (const query of [
      "/usage/summary?source=bogus",
      "/usage/summary?status=done",
      "/usage/summary?from=2026-02-01&to=2026-01-01",
      "/usage/summary?from=yesterday",
      "/usage/summary?provider=a%3Bdrop",
      "/usage/summary?tz=900",
      "/usage/summary?tz=1.5",
      "/usage/events?limit=0",
      "/usage/events?limit=101",
      "/usage/events?cursor=garbage",
      "/usage/export?format=xlsx",
      "/activities?kind=DROP%20TABLE",
      "/activities?before=abc",
      "/activities?from=never",
    ]) {
      const response = await api(a.browser, a.key, query);
      expect(response.status, query).toBe(400);
      expect(await body(response)).toMatchObject({ error: { code: "bad_request" } });
    }
  });

  it("exports CSV with formula cells neutralised, and JSON", async () => {
    const { usage, a } = await setup();
    await post(a.browser, a.key, "/usage/import", {
      entries: [entry({ command: "-cmd injected" })],
    });
    const csv = await api(a.browser, a.key, "/usage/export");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="multix-usage.csv"');
    expect(csv.headers.get("x-multix-truncated")).toBeNull();
    const text = await csv.text();
    expect(text.split("\n")[0]).toMatch(/^id,started_at,/);
    expect(text).toContain(",'-cmd injected,");
    expect(text).not.toMatch(/,-cmd injected,/);

    const asJson = await body(await api(a.browser, a.key, "/usage/export?format=json"));
    expect(asJson).toMatchObject({ truncated: false });
    expect(asJson.items).toHaveLength(1);
    const exported = await usage.service("gh-1").activities({ kind: "usage.exported" });
    expect(exported.items).toHaveLength(2);
  });

  it("deletes usage only with the confirmation parameter", async () => {
    const { a } = await setup();
    await post(a.browser, a.key, "/usage/import", { entries: [entry(), entry()] });
    const unconfirmed = await api(a.browser, a.key, "/usage", { method: "DELETE" });
    expect(unconfirmed.status).toBe(400);
    const deleted = await api(a.browser, a.key, "/usage?confirm=delete-all-usage", {
      method: "DELETE",
    });
    expect(await body(deleted)).toEqual({ deleted: 2 });
    expect((await body(await api(a.browser, a.key, "/usage/events"))).items).toEqual([]);
  });

  it("answers 503 when the server keeps no usage ledger", async () => {
    const { a } = await setup({ MULTIX_USAGE: undefined });
    for (const path of ["/usage/summary", "/budgets", "/activities", "/rate-card", "/balances"]) {
      const response = await api(a.browser, a.key, path);
      expect(response.status, path).toBe(503);
      expect(await body(response)).toMatchObject({ error: { code: "unavailable" } });
    }
    // Account routes keep working without the ledger; their activity entry is simply skipped.
    const saved = await post(
      a.browser,
      a.key,
      "/provider-keys/GEMINI_API_KEY",
      { value: GEMINI_KEY },
      "PUT",
    );
    expect(saved.status).toBe(200);
  });
});

describe("budgets, activities, rate card", () => {
  it("creates, lists, changes and deletes budgets", async () => {
    const { usage, a } = await setup();
    const created = await post(a.browser, a.key, "/budgets", {
      name: "Monthly",
      scope: "account",
      period: "month",
      limitUsd: 50,
      mode: "alert",
    });
    expect(created.status).toBe(201);
    const budget = await body(created);
    expect(budget).toMatchObject({ name: "Monthly", limitUsd: 50 });

    const list = await body(await api(a.browser, a.key, "/budgets"));
    expect(list.budgets).toHaveLength(1);
    expect(list.budgets[0]).toMatchObject({ budget: { id: budget.id }, committedUsd: 0 });

    const patched = await post(
      a.browser,
      a.key,
      `/budgets/${budget.id}`,
      { limitUsd: 80 },
      "PATCH",
    );
    expect(await body(patched)).toMatchObject({ id: budget.id, limitUsd: 80, name: "Monthly" });
    const invalid = await post(a.browser, a.key, `/budgets/${budget.id}`, { mode: "x" }, "PATCH");
    expect(invalid.status).toBe(400);
    expect((await post(a.browser, a.key, "/budgets", { name: "" })).status).toBe(400);

    const removed = await api(a.browser, a.key, `/budgets/${budget.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(
      (await api(a.browser, a.key, `/budgets/${budget.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    const kinds = (await usage.service("gh-1").activities({ kind: "budget." })).items.map(
      (i) => i.kind,
    );
    expect(kinds.sort()).toEqual(["budget.created", "budget.deleted", "budget.updated"]);
  });

  it("lists and verifies the activity log, with key changes logged by name only", async () => {
    const { a } = await setup();
    await post(
      a.browser,
      a.key,
      "/provider-keys",
      { keys: { GEMINI_API_KEY: GEMINI_KEY } },
      "PATCH",
    );
    await api(a.browser, a.key, "/provider-keys/GEMINI_API_KEY", { method: "DELETE" });
    await api(a.browser, a.key, "/storage", { method: "DELETE" });
    const log = await api(a.browser, a.key, "/activities?limit=2");
    const text = await log.clone().text();
    expect(text).not.toContain(GEMINI_KEY);
    expect(text).not.toContain(a.key);
    const page = await body(log);
    expect(page.items.map((i: Json) => i.kind)).toEqual([
      "storage.removed",
      "provider_key.removed",
    ]);
    expect(page.items[1]).toMatchObject({
      actor: `api_key:${a.keyId}`,
      target: "GEMINI_API_KEY",
    });
    const rest = await body(await api(a.browser, a.key, `/activities?before=${page.next}`));
    expect(rest.items.map((i: Json) => i.kind)).toContain("provider_key.saved");
    const filtered = await body(await api(a.browser, a.key, "/activities?kind=provider_key."));
    expect(filtered.items).toHaveLength(2);

    expect(await body(await api(a.browser, a.key, "/activities/verify"))).toEqual({
      ok: true,
      checked: 3,
      brokenAtSeq: null,
    });

    const revoked = await api(a.browser, a.key, `/api-keys/${a.keyId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
  });

  it("logs API key revocations", async () => {
    const { usage, a } = await setup();
    await api(a.browser, a.key, `/api-keys/${a.keyId}`, { method: "DELETE" });
    const revoked = await usage.service("gh-1").activities({ kind: "api_key.revoked" });
    expect(revoked.items[0]).toMatchObject({ target: a.keyId, actor: `api_key:${a.keyId}` });
  });

  it("replaces and reads the rate card", async () => {
    const { a } = await setup();
    expect(await body(await api(a.browser, a.key, "/rate-card"))).toEqual({ entries: [] });
    const entries = [
      {
        provider: "gemini",
        model: "*",
        unit: "output",
        usd: 0.039,
        effectiveFrom: "2026-10-01",
        version: "pricing page",
      },
    ];
    const put = await post(a.browser, a.key, "/rate-card", { entries }, "PUT");
    expect(put.status).toBe(200);
    expect((await body(put)).entries).toMatchObject(entries);
    expect((await body(await api(a.browser, a.key, "/rate-card"))).entries).toHaveLength(1);
    const bad = await post(a.browser, a.key, "/rate-card", { entries: [{ provider: "x" }] }, "PUT");
    expect(bad.status).toBe(400);
    expect((await post(a.browser, a.key, "/rate-card", {}, "PUT")).status).toBe(400);
  });
});

describe("balances", () => {
  it("refreshes with the saved keys, stores the result and never returns key values", async () => {
    const { usage, a } = await setup();
    await post(
      a.browser,
      a.key,
      "/provider-keys",
      {
        keys: {
          OPENROUTER_API_KEY: OPENROUTER_KEY,
          ELEVENLABS_API_KEY: ELEVENLABS_KEY,
          GEMINI_API_KEY: GEMINI_KEY,
        },
      },
      "PATCH",
    );
    expect(await body(await api(a.browser, a.key, "/balances"))).toEqual({ balances: [] });
    const refreshed = await api(a.browser, a.key, "/balances/refresh", { method: "POST" });
    expect(refreshed.status).toBe(200);
    const text = await refreshed.clone().text();
    const { balances } = await body(refreshed);
    expect(balances.map((b: Json) => [b.provider, b.status])).toEqual([
      ["elevenlabs", "forbidden"],
      ["gemini", "unsupported"],
      ["openrouter", "ok"],
    ]);
    expect(balances[2]).toMatchObject({ kind: "cash", unit: "USD", remaining: 15, used: 5 });
    const stored = await api(a.browser, a.key, "/balances");
    expect((await body(stored)).balances).toEqual(balances);

    const activities = JSON.stringify(await usage.service("gh-1").activities({ limit: 100 }));
    for (const secret of [OPENROUTER_KEY, ELEVENLABS_KEY, GEMINI_KEY, a.key]) {
      expect(text).not.toContain(secret);
      expect(activities).not.toContain(secret);
    }
    expect(activities).toContain("balances.refreshed");
  });
});

describe("cross-account isolation", () => {
  it("never lets one account's key read or change another account's usage", async () => {
    const { a, account } = await setup();
    await post(a.browser, a.key, "/usage/import", { entries: [entry()] });
    const budget = await body(
      await post(a.browser, a.key, "/budgets", {
        name: "A only",
        scope: "account",
        period: "day",
        limitUsd: 5,
      }),
    );
    const eventId = (await body(await api(a.browser, a.key, "/usage/events"))).items[0].id;

    const b = await account(HUBOT);
    expect((await body(await api(b.browser, b.key, "/usage/events"))).items).toEqual([]);
    expect((await body(await api(b.browser, b.key, "/usage/summary"))).kpis.jobs).toBe(0);
    expect((await api(b.browser, b.key, `/usage/events/${eventId}`)).status).toBe(404);
    expect(
      (
        await post(b.browser, b.key, `/usage/events/${eventId}/adjustments`, {
          kind: "refund",
          amountUsd: 1,
          reason: "steal",
        })
      ).status,
    ).toBe(404);
    expect((await body(await api(b.browser, b.key, "/budgets"))).budgets).toEqual([]);
    expect(
      (await post(b.browser, b.key, `/budgets/${budget.id}`, { limitUsd: 1 }, "PATCH")).status,
    ).toBe(404);
    expect(
      (await api(b.browser, b.key, `/budgets/${budget.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    // B's import of the same history id is B's own run, not a duplicate of A's.
    const replay = await post(b.browser, b.key, "/usage/import", {
      entries: [
        entry({
          id: (await body(await api(a.browser, a.key, `/usage/events/${eventId}`))).event.historyId,
        }),
      ],
    });
    expect(await body(replay)).toMatchObject({ accepted: 1, duplicates: 0 });
    expect((await body(await api(a.browser, a.key, "/budgets"))).budgets).toHaveLength(1);
  });
});

describe("REST jobs and the usage ledger", () => {
  async function jobsSetup() {
    const { namespace } = fakeNamespace();
    const ctx = await setup({ MULTIX_JOBS: namespace, MULTIX_JOB_QUOTA: fakeQuotaNamespace() });
    await post(
      ctx.a.browser,
      ctx.a.key,
      "/provider-keys",
      { keys: { GEMINI_API_KEY: GEMINI_KEY } },
      "PATCH",
    );
    return ctx;
  }

  it("records REST jobs with source rest, the API key as client and the project", async () => {
    const { a } = await jobsSetup();
    const run = await post(a.browser, a.key, "/jobs", {
      command: "gemini generate",
      options: { prompt: "a cat" },
      project: "landing-page",
    });
    expect(run.status).toBe(200);
    const job = await body(run);
    const detail = await body(await api(a.browser, a.key, `/usage/events/${job.job_id}`));
    expect(detail.event).toMatchObject({
      source: "rest",
      clientId: `api_key:${a.keyId}`,
      project: "landing-page",
      provider: "gemini",
    });

    const bad = await post(a.browser, a.key, "/jobs", {
      command: "gemini generate",
      options: { prompt: "a cat" },
      project: "has spaces",
    });
    expect(bad.status).toBe(400);
    expect(await body(bad)).toMatchObject({ error: { code: "bad_request" } });
  });

  it("answers 402 budget_exceeded when a blocking budget refuses the job", async () => {
    const { a } = await jobsSetup();
    await post(a.browser, a.key, "/budgets", {
      name: "Hard cap",
      scope: "account",
      period: "month",
      limitUsd: 1,
      mode: "block",
      unknownPrice: "block",
    });
    const run = await post(a.browser, a.key, "/jobs", {
      command: "gemini generate",
      options: { prompt: "a cat" },
    });
    expect(run.status).toBe(402);
    expect(await body(run)).toMatchObject({ error: { code: "budget_exceeded" } });
  });
});
