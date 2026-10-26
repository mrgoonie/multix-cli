import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/config.js";
import type { AccountLedgerNamespace, AccountLedgerStub } from "../src/ledger/account-ledger.js";
import { importRecords } from "../src/ledger/ledger-records.js";
import { MAX_BUDGETS, MAX_EXPORT_ROWS } from "../src/ledger/usage-ledger.js";
import {
  fakeEventsNamespace,
  fakeLedgerNamespace,
  fakeNamespace,
  fakeQuotaNamespace,
} from "./fake-job-bindings.js";
import { type RecordedCall, callTool, fullEnv, jsonResponse, route, rpc } from "./helpers.js";
import {
  type Browser,
  authorizeAndGetToken,
  githubFetch,
  hiddenField,
  mcpCall,
  newBrowser,
  oauthEnv,
  registerClient,
  signIn,
} from "./oauth-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies are untyped in tests
type Json = any;

const OCTOCAT = { id: 1, login: "octocat" };
const HUBOT = { id: 2, login: "hubot" };
const GEMINI_KEY = "AIza-gemini-secret-value-1234";
const OPENAI_KEY = "sk-openai-secret-value-123456";
const R2_SECRET = "r2-secret-access-key-0123456789abcdef";
const CALLBACK_TOKEN = "cb-token-secret-0123456789";
const CALLBACK = `https://hooks.example.com/multix/in?token=${CALLBACK_TOKEN}`;
const HOUR_MS = 3_600_000;

/**
 * The fake job finishes at epoch 2 ms; record it as having just run, so it
 * falls in the default "last 30 days" windows of the API and the MCP tool.
 */
function liveTimes(namespace: AccountLedgerNamespace): AccountLedgerNamespace {
  return {
    getByName(name) {
      const stub = namespace.getByName(name);
      const recordFinish: AccountLedgerStub["recordFinish"] = (input) => {
        const now = Date.now();
        return stub.recordFinish({ ...input, started_at: now - 1000, finished_at: now });
      };
      return new Proxy(stub, {
        get: (target, method: keyof AccountLedgerStub) =>
          method === "recordFinish" ? recordFinish : target[method],
      });
    },
  };
}

/** DNS-over-HTTPS: every name resolves to a public address. */
const dns = route("GET", /^https:\/\/cloudflare-dns\.com\/dns-query\?/, (call) => {
  const type = new URL(call.url).searchParams.get("type");
  return jsonResponse(
    type === "A" ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] } : { Status: 0 },
  );
});

/** R2 bucket check (list, probe upload, probe delete) always succeeds. */
const r2 = (call: RecordedCall) =>
  call.url.includes(".r2.cloudflarestorage.com/") ? new Response(null, { status: 200 }) : undefined;

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

interface Caller {
  browser: Browser;
  key: string;
  call(path: string, init?: RequestInit): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<Json>;
}

async function caller(env: WorkerEnv, user = OCTOCAT): Promise<Caller> {
  const browser = newBrowser(env, githubFetch(user, dns, r2).fetch);
  await signIn(browser);
  const key = await createApiKey(browser);
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${key}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return browser.request(`/api/v1${path}`, { ...init, headers });
  };
  return { browser, key, call, json: async (path, init) => body(await call(path, init)) };
}

const post = (payload: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(payload),
});

async function ledgerEnv(overrides: Partial<WorkerEnv> = {}) {
  const ledger = await fakeLedgerNamespace();
  const env = oauthEnv({
    MULTIX_ALLOWED_USERS: "octocat,hubot",
    MULTIX_LEDGER: ledger.namespace,
    ...overrides,
  });
  return { env, ledger };
}

/** A CLI history entry as `multix history push` sends it. */
function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ts: new Date(Date.now() - HOUR_MS).toISOString(),
    command: "gemini generate",
    provider: "gemini",
    model: "gemini-2.5-flash-image",
    ok: true,
    duration_ms: 1200,
    outputs: [{ bytes: 100, mime: "image/png" }],
    ...extra,
  };
}

const VALID_BUDGET = {
  name: "Gemini monthly",
  scope_kind: "provider",
  scope_value: "gemini",
  period: "month",
  limit_usd: 10,
};

describe("usage API without the ledger binding", () => {
  it("answers 503 ledger_unavailable on every usage, budget and activity route", async () => {
    const env = oauthEnv();
    const a = await caller(env);
    const routes: [string, string, unknown?][] = [
      ["GET", "/usage/summary"],
      ["GET", "/usage/operations"],
      ["GET", "/usage/operations/cli_x"],
      ["POST", "/usage/operations/cli_x/adjustments", { kind: "refund", amount_usd: -1 }],
      ["GET", "/usage/export"],
      ["POST", "/usage/import", { entries: [] }],
      ["DELETE", "/usage/data?confirm=delete"],
      ["GET", "/budgets"],
      ["POST", "/budgets", VALID_BUDGET],
      ["GET", "/budgets/bud_x"],
      ["PUT", "/budgets/bud_x", VALID_BUDGET],
      ["DELETE", "/budgets/bud_x"],
      ["GET", "/activities"],
      ["GET", "/activities/verify"],
    ];
    for (const [method, path, payload] of routes) {
      const response = await a.call(path, {
        method,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await body(response)).toMatchObject({ error: { code: "ledger_unavailable" } });
    }
    // REST account actions keep working without a ledger to log them in.
    const saved = await a.call("/provider-keys/GEMINI_API_KEY", post({ value: GEMINI_KEY }, "PUT"));
    expect(saved.status).toBe(200);
  });
});

describe("usage API", () => {
  it("records REST jobs with null (never 0) unknown costs and summarises them", async () => {
    const { env, ledger } = await ledgerEnv();
    env.MULTIX_JOBS = fakeNamespace(liveTimes(ledger.namespace)).namespace;
    env.MULTIX_JOB_QUOTA = fakeQuotaNamespace();
    const a = await caller(env);
    await a.call("/provider-keys/GEMINI_API_KEY", post({ value: GEMINI_KEY }, "PUT"));
    const me = await a.json("/me");
    const job = await a.json(
      "/jobs",
      post({ command: "gemini generate", options: { prompt: "a secret prompt" } }),
    );
    expect(job.status).toBe("succeeded");

    const list = await a.json("/usage/operations");
    expect(list.next_cursor).toBeNull();
    expect(list.operations).toHaveLength(1);
    const [op] = list.operations;
    expect(op).toMatchObject({
      op_id: `job_${job.job_id}`,
      source: "rest",
      client_id: `api_key:${me.api_key_id}`,
      status: "succeeded",
      actual_cost_usd: null,
      estimated_cost_usd: null,
      tokens_input: null,
      credits: null,
      cost_provenance: "unknown",
    });

    const detail = await a.json(`/usage/operations/${op.op_id}`);
    expect(detail).toEqual({ operation: op, adjustments: [] });
    expect((await a.call("/usage/operations/job_unknown")).status).toBe(404);

    const summary = await a.json("/usage/summary?group_by=source");
    expect(summary.totals).toMatchObject({
      operations: 1,
      succeeded: 1,
      known_cost_usd: 0,
      unknown_cost_operations: 1,
      cost_per_successful_output_usd: null,
      tokens_input: null,
      credits: null,
    });
    expect(summary.groups.map((g: Json) => g.key)).toEqual(["rest"]);
    expect(summary.budgets).toEqual([]);
    expect(JSON.stringify([list, summary])).not.toContain("secret prompt");

    const json = await a.json("/usage/export?format=json");
    expect(json.truncated).toBe(false);
    expect(json.operations[0].actual_cost_usd).toBeNull();
  });

  it("imports CLI history idempotently and counts rejected entries", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    const batch = {
      entries: [
        entry("h_1", { usage: { cost_usd: 0.25, tokens: { input: 10, output: 20 } } }),
        entry("h_2"),
        { id: "bad id with spaces", ts: "x", command: "gemini generate", ok: true },
        "not an object",
      ],
    };
    const first = await a.call("/usage/import", post(batch));
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({ accepted: 2, duplicates: 0, rejected: 2 });
    expect(await a.json("/usage/import", post(batch))).toEqual({
      accepted: 0,
      duplicates: 2,
      rejected: 2,
    });

    const summary = await a.json("/usage/summary");
    expect(summary.totals).toMatchObject({
      operations: 2,
      provider_reported_cost_usd: 0.25,
      known_cost_usd: 0.25,
      unknown_cost_operations: 1,
    });
    const unknown = await a.json("/usage/operations/cli_h_2");
    expect(unknown.operation).toMatchObject({
      source: "cli",
      actual_cost_usd: null,
      estimated_cost_usd: null,
      tokens_total: null,
    });

    const tooMany = await a.call(
      "/usage/import",
      post({ entries: Array.from({ length: 201 }, (_, i) => entry(`m_${i}`)) }),
    );
    expect(tooMany.status).toBe(400);
    expect(await body(tooMany)).toMatchObject({ error: { code: "bad_request" } });
    expect((await a.call("/usage/import", post({ entries: "x" }))).status).toBe(400);
    expect((await a.call("/usage/import", post({}))).status).toBe(400);
    const huge = await a.call(
      "/usage/import",
      post({ entries: [entry("h_big", { pad: "x".repeat(600 * 1024) })] }),
    );
    expect(huge.status).toBe(413);
    // A full 200-entry batch fits although it is larger than the default 64 KiB body limit.
    const full = Array.from({ length: 200 }, (_, i) =>
      entry(`f_${i}`, {
        provider_ids: ["pred_0123456789abcdef0123456789abcdef"],
        outputs: [1, 2].map((n) => ({ bytes: n, mime: "image/png", sha256: "ab".repeat(32) })),
      }),
    );
    expect(JSON.stringify({ entries: full }).length).toBeGreaterThan(64 * 1024);
    expect(await a.json("/usage/import", post({ entries: full }))).toEqual({
      accepted: 200,
      duplicates: 0,
      rejected: 0,
    });
    // Other routes keep the default limit.
    const bigBudget = await a.call("/budgets", post({ ...VALID_BUDGET, pad: "x".repeat(70_000) }));
    expect(bigBudget.status).toBe(413);

    const page1 = await a.json("/usage/operations?limit=150&provider=gemini");
    expect(page1.operations).toHaveLength(150);
    const page2 = await a.json(
      `/usage/operations?limit=150&cursor=${encodeURIComponent(page1.next_cursor)}`,
    );
    expect(page2.operations).toHaveLength(52);
    expect(page2.next_cursor).toBeNull();
    expect((await a.call("/usage/operations?limit=201")).status).toBe(400);
    expect((await a.call("/usage/operations?cursor=nope")).status).toBe(400);
    expect((await a.call("/usage/operations?source=moon")).status).toBe(400);
    expect((await a.call("/usage/summary?from=2026-01-02&to=2026-01-01")).status).toBe(400);
  });

  it("adjusts an operation's cost and validates the adjustment", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    await a.call("/usage/import", post({ entries: [entry("h_1", { usage: { cost_usd: 1 } })] }));
    const path = "/usage/operations/cli_h_1/adjustments";
    const created = await a.call(
      path,
      post({ kind: "refund", amount_usd: -0.4, note: " partial " }),
    );
    expect(created.status).toBe(201);
    const adjustment = await body(created);
    expect(adjustment).toMatchObject({ op_id: "cli_h_1", kind: "refund", amount_usd: -0.4 });
    expect(adjustment.note).toBe("partial");
    expect(adjustment.actor).toMatch(/^api_key:/);
    const detail = await a.json("/usage/operations/cli_h_1");
    expect(detail.adjustments).toEqual([adjustment]);
    expect((await a.json("/usage/summary")).totals.known_cost_usd).toBe(0.6);

    for (const bad of [
      { kind: "gift", amount_usd: 1 },
      { kind: "refund" },
      { kind: "refund", amount_usd: "1" },
      { kind: "refund", amount_usd: 1_000_001 },
      { kind: "correction", amount_usd: -1_000_001 },
      { kind: "correction", amount_usd: 1, note: "x".repeat(201) },
      { kind: "correction", amount_usd: 1, note: 5 },
    ]) {
      const response = await a.call(path, post(bad));
      expect(response.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(
      (
        await a.call(
          "/usage/operations/cli_nope/adjustments",
          post({ kind: "refund", amount_usd: -1 }),
        )
      ).status,
    ).toBe(404);
    expect((await a.call(path)).status).toBe(405);
  });

  it("exports CSV with download headers and formula protection", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    await a.call(
      "/usage/import",
      post({
        entries: [
          entry("h_ok", { usage: { cost_usd: 0.5 } }),
          entry("h_bad", { ok: false, error_code: "-SUM.A1" }),
        ],
      }),
    );
    const from = Date.UTC(2026, 0, 1);
    const to = Date.now() + HOUR_MS;
    const response = await a.call(`/usage/export?format=csv&from=${from}&to=${to}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="multix-usage-${day(from)}-${day(to)}.csv"`,
    );
    expect(response.headers.get("x-multix-truncated")).toBeNull();
    const csv = await response.text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]?.startsWith("op_id,started_at,")).toBe(true);
    expect(lines).toHaveLength(3);
    expect(csv).toContain(",'-SUM.A1,");
    expect(csv).not.toContain(",-SUM.A1,");
    // Unknown cost is an empty cell, never 0.
    const header = lines[0]?.split(",") ?? [];
    const failed = lines.find((l) => l.startsWith("cli_h_bad"))?.split(",") ?? [];
    expect(failed[header.indexOf("actual_cost_usd")]).toBe("");

    expect((await a.call("/usage/export?format=xml")).status).toBe(400);
    const exported = await a.json("/activities?kind=usage.exported");
    expect(exported.activities[0].metadata).toMatchObject({ format: "csv", rows: 2 });
  });

  // Writes MAX_EXPORT_ROWS + 1 rows into SQLite, which takes a few seconds on a busy machine.
  it("caps a large export and flags it as truncated", { timeout: 60_000 }, async () => {
    const { env, ledger } = await ledgerEnv();
    const a = await caller(env);
    const { id: userId } = await a.json("/me");
    const many = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => entry(`bulk_${i}`));
    const { operations } = importRecords(many, "test");
    await ledger.namespace.getByName(userId).importOperations(operations, "test");
    const capped = await a.call("/usage/export");
    expect(capped.headers.get("x-multix-truncated")).toBe("true");
    expect((await capped.text()).trimEnd().split("\r\n")).toHaveLength(MAX_EXPORT_ROWS + 1);
    const cappedJson = await a.json("/usage/export?format=json");
    expect(cappedJson.truncated).toBe(true);
    expect(cappedJson.operations).toHaveLength(MAX_EXPORT_ROWS);
  });

  it("deletes usage data only with confirm=delete and keeps budgets", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    await a.call("/usage/import", post({ entries: [entry("h_1")] }));
    const budget = await a.json("/budgets", post(VALID_BUDGET));
    const refused = await a.call("/usage/data", { method: "DELETE" });
    expect(refused.status).toBe(400);
    expect((await a.call("/usage/data?confirm=yes", { method: "DELETE" })).status).toBe(400);
    expect((await a.json("/usage/operations")).operations).toHaveLength(1);

    expect(await a.json("/usage/data?confirm=delete", { method: "DELETE" })).toEqual({
      deleted: true,
    });
    expect((await a.json("/usage/operations")).operations).toEqual([]);
    expect((await a.json("/budgets")).budgets.map((b: Json) => b.id)).toEqual([budget.id]);
    const activities = await a.json("/activities");
    expect(activities.activities.map((x: Json) => x.kind)).toEqual(["ledger.deleted"]);
    expect(await a.json("/activities/verify")).toEqual({
      ok: true,
      checked: 1,
      first_bad_seq: null,
    });
    expect((await a.call("/usage/data")).status).toBe(405);
  });
});

describe("budgets API", () => {
  it("creates, reads, replaces and deletes budgets", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    await a.call("/usage/import", post({ entries: [entry("h_1", { usage: { cost_usd: 6 } })] }));

    const created = await a.call("/budgets", post({ ...VALID_BUDGET, name: "  Gemini monthly  " }));
    expect(created.status).toBe(201);
    const budget = await body(created);
    expect(budget).toMatchObject({
      name: "Gemini monthly",
      scope_kind: "provider",
      scope_value: "gemini",
      period: "month",
      limit_usd: 10,
      thresholds: [50, 80, 100],
      spent_usd: 6,
      state: "warning",
      alerts: [50],
    });
    expect(await a.json(`/budgets/${budget.id}`)).toMatchObject({ id: budget.id, spent_usd: 6 });
    expect((await a.json("/budgets")).budgets).toHaveLength(1);

    const replaced = await a.call(
      `/budgets/${budget.id}`,
      post(
        {
          name: "Everything",
          scope_kind: "account",
          scope_value: "ignored",
          period: "day",
          limit_usd: 100,
          thresholds: [100, 25],
        },
        "PUT",
      ),
    );
    expect(replaced.status).toBe(200);
    expect(await body(replaced)).toMatchObject({
      id: budget.id,
      name: "Everything",
      scope_kind: "account",
      scope_value: null,
      period: "day",
      thresholds: [25, 100],
    });
    expect((await a.call("/budgets/bud_missing", post(VALID_BUDGET, "PUT"))).status).toBe(404);

    expect(await a.json(`/budgets/${budget.id}`, { method: "DELETE" })).toEqual({ deleted: true });
    expect((await a.call(`/budgets/${budget.id}`)).status).toBe(404);
    expect((await a.call(`/budgets/${budget.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await a.call("/budgets", { method: "DELETE" })).status).toBe(405);
    expect((await a.call(`/budgets/${budget.id}/x`)).status).toBe(404);

    const kinds = (await a.json("/activities?kind=budget.")).activities.map((x: Json) => x.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["budget.created", "budget.updated", "budget.deleted"]),
    );
  });

  it("validates budgets field by field", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "" }, "name"],
      [{ name: "   " }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ name: "a\nb" }, "name"],
      [{ scope_kind: "planet" }, "scope_kind"],
      [{ scope_value: undefined }, "scope_value"],
      [{ scope_value: "" }, "scope_value"],
      [{ scope_value: "-gemini" }, "scope_value"],
      [{ scope_value: "x".repeat(201) }, "scope_value"],
      [{ period: "year" }, "period"],
      [{ limit_usd: 0 }, "limit_usd"],
      [{ limit_usd: -5 }, "limit_usd"],
      [{ limit_usd: "5" }, "limit_usd"],
      [{ limit_usd: 10_000_001 }, "limit_usd"],
      [{ thresholds: [] }, "thresholds"],
      [{ thresholds: [50, 50] }, "thresholds"],
      [{ thresholds: [0] }, "thresholds"],
      [{ thresholds: [1001] }, "thresholds"],
      [{ thresholds: [1.5] }, "thresholds"],
      [{ thresholds: [1, 2, 3, 4, 5, 6] }, "thresholds"],
      [{ thresholds: "50" }, "thresholds"],
    ];
    for (const [change, field] of cases) {
      const response = await a.call("/budgets", post({ ...VALID_BUDGET, ...change }));
      expect(response.status, JSON.stringify(change).slice(0, 60)).toBe(400);
      const error = (await body(response)).error;
      expect(error.code).toBe("bad_request");
      expect(error.message).toContain(field);
    }
    expect((await a.json("/budgets")).budgets).toEqual([]);
    expect(
      await a.json(
        "/budgets",
        post({ ...VALID_BUDGET, limit_usd: 10_000_000, thresholds: [1000] }),
      ),
    ).toMatchObject({ thresholds: [1000] });
  });

  it(`refuses more than ${MAX_BUDGETS} budgets with 409 budget_limit`, async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    for (let i = 0; i < MAX_BUDGETS; i++) {
      expect((await a.call("/budgets", post({ ...VALID_BUDGET, name: `b${i}` }))).status).toBe(201);
    }
    const over = await a.call("/budgets", post({ ...VALID_BUDGET, name: "over" }));
    expect(over.status).toBe(409);
    expect(await body(over)).toMatchObject({ error: { code: "budget_limit" } });
  });
});

describe("activities API", () => {
  it("logs REST account changes without key values, credentials, prompts or full URLs", async () => {
    const { env } = await ledgerEnv();
    env.MULTIX_EVENTS = fakeEventsNamespace().namespace;
    const a = await caller(env);
    const second = await createApiKey(a.browser, "second");

    await a.call("/provider-keys", post({ keys: { GEMINI_API_KEY: GEMINI_KEY } }, "PATCH"));
    await a.call("/provider-keys/OPENAI_API_KEY", post({ value: OPENAI_KEY }, "PUT"));
    await a.call("/provider-keys/OPENAI_API_KEY", { method: "DELETE" });
    const storage = await a.call(
      "/storage",
      post(
        {
          account_id: "0123456789abcdef0123456789abcdef",
          access_key_id: "AKIDEXAMPLE0123456789",
          secret_access_key: R2_SECRET,
          bucket: "my-bucket",
        },
        "PUT",
      ),
    );
    expect(storage.status).toBe(200);
    await a.call("/storage", { method: "DELETE" });
    const subscribed = await a.json(
      "/events/subscriptions",
      post({ callback_url: CALLBACK, events: ["multix.job.failed"] }),
    );
    const subscriptionId = subscribed.subscription.id;
    await a.call(`/events/subscriptions/${subscriptionId}`, { method: "DELETE" });
    const keys = await a.json("/api-keys");
    const secondId = keys.api_keys.find((k: Json) => k.name === "second").id;
    expect((await a.call(`/api-keys/${secondId}`, { method: "DELETE" })).status).toBe(200);

    const raw = await (await a.call("/activities")).text();
    const me = await a.json("/me");
    const actor = `api_key:${me.api_key_id}`;
    // Only what this API key did (the dashboard may log its own actions too).
    const activities = JSON.parse(raw).activities.filter((x: Json) => x.actor === actor);
    const logged = activities.map((x: Json) => [x.kind, x.subject]).reverse();
    expect(logged).toEqual([
      ["provider_key.saved", "GEMINI_API_KEY"],
      ["provider_key.saved", "OPENAI_API_KEY"],
      ["provider_key.removed", "OPENAI_API_KEY"],
      ["storage.updated", "my-bucket"],
      ["storage.removed", null],
      ["webhook.subscribed", subscriptionId],
      ["webhook.unsubscribed", subscriptionId],
      ["api_key.revoked", secondId],
    ]);
    const webhook = activities.find((x: Json) => x.kind === "webhook.subscribed");
    expect(webhook.metadata).toEqual({ host: "hooks.example.com", events: 1 });
    for (const secret of [
      GEMINI_KEY,
      OPENAI_KEY,
      R2_SECRET,
      "AKIDEXAMPLE0123456789",
      CALLBACK_TOKEN,
      "/multix/in",
      subscribed.secret,
      second,
      a.key,
    ]) {
      expect(raw).not.toContain(secret);
    }
    const verified = await a.json("/activities/verify");
    expect(verified).toMatchObject({ ok: true, first_bad_seq: null });
    expect(verified.checked).toBeGreaterThanOrEqual(8);
  });

  it("filters and pages activities and validates the query", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env);
    for (const name of ["GEMINI_API_KEY", "OPENAI_API_KEY", "REPLICATE_API_TOKEN"]) {
      await a.call(`/provider-keys/${name}`, post({ value: GEMINI_KEY }, "PUT"));
      await a.call(`/provider-keys/${name}`, { method: "DELETE" });
    }
    const removed = await a.json("/activities?kind=provider_key.removed");
    expect(removed.activities).toHaveLength(3);
    const searched = await a.json("/activities?q=replicate");
    expect(searched.activities.map((x: Json) => x.kind).sort()).toEqual([
      "provider_key.removed",
      "provider_key.saved",
    ]);
    const page1 = await a.json("/activities?kind=provider_key.&limit=4");
    expect(page1.activities).toHaveLength(4);
    expect(page1.next_cursor).toMatch(/^\d+$/);
    const page2 = await a.json(
      `/activities?kind=provider_key.&limit=4&cursor=${page1.next_cursor}`,
    );
    expect(page2.activities).toHaveLength(2);
    expect(page2.next_cursor).toBeNull();
    const seqs = [...page1.activities, ...page2.activities].map((x: Json) => x.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
    const future = Date.now() + HOUR_MS;
    expect((await a.json(`/activities?from=${future}`)).activities).toEqual([]);

    for (const query of [
      "kind=Bad-Kind",
      `kind=${"a".repeat(65)}`,
      `q=${"x".repeat(101)}`,
      "cursor=abc",
      "limit=0",
      "limit=201",
      "from=yesterday",
      `from=${future}&to=${future - 1}`,
    ]) {
      expect((await a.call(`/activities?${query}`)).status, query).toBe(400);
    }
    expect((await a.call("/activities", post({}))).status).toBe(405);
    expect((await a.call("/activities/other")).status).toBe(404);
  });
});

describe("usage API account isolation", () => {
  it("never lets one account read, adjust, export, delete or verify another's records", async () => {
    const { env } = await ledgerEnv();
    const a = await caller(env, OCTOCAT);
    const b = await caller(env, HUBOT);
    await a.call("/usage/import", post({ entries: [entry("h_a", { usage: { cost_usd: 2 } })] }));
    const budget = await a.json("/budgets", post(VALID_BUDGET));

    const opPath = "/usage/operations/cli_h_a";
    expect((await b.call(opPath)).status).toBe(404);
    expect(
      (await b.call(`${opPath}/adjustments`, post({ kind: "correction", amount_usd: 5 }))).status,
    ).toBe(404);
    expect((await b.json("/usage/operations")).operations).toEqual([]);
    const summary = await b.json("/usage/summary");
    expect(summary.totals).toMatchObject({ operations: 0, known_cost_usd: 0 });
    expect(summary.budgets).toEqual([]);
    expect((await b.json("/usage/export?format=json")).operations).toEqual([]);
    expect((await (await b.call("/usage/export")).text()).trimEnd().split("\r\n")).toHaveLength(1);
    expect((await b.call(`/budgets/${budget.id}`)).status).toBe(404);
    expect((await b.call(`/budgets/${budget.id}`, post(VALID_BUDGET, "PUT"))).status).toBe(404);
    expect((await b.call(`/budgets/${budget.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await b.json("/budgets")).budgets).toEqual([]);
    expect(await b.json("/usage/data?confirm=delete", { method: "DELETE" })).toEqual({
      deleted: true,
    });
    const bActivities = await b.json("/activities");
    expect(JSON.stringify(bActivities)).not.toContain("cli_h_a");
    expect(JSON.stringify(bActivities)).not.toContain(budget.id);
    const bVerify = await b.json("/activities/verify");
    expect(bVerify.ok).toBe(true);

    // A's records are untouched.
    expect((await a.json(opPath)).adjustments).toEqual([]);
    expect((await a.json("/usage/summary")).totals.known_cost_usd).toBe(2);
    expect((await a.json(`/budgets/${budget.id}`)).spent_usd).toBe(2);
    const aKinds = (await a.json("/activities")).activities.map((x: Json) => x.kind);
    expect(aKinds).not.toContain("ledger.deleted");
    expect((await a.json("/activities/verify")).checked).toBe(aKinds.length);
  });
});

describe("multix_usage_summary MCP tool", () => {
  async function mcpResult(response: Response): Promise<Json> {
    expect(response.status).toBe(200);
    return ((await response.json()) as Json).result;
  }

  it("is listed, read-only, only when the account has a ledger", async () => {
    const ledger = await fakeLedgerNamespace();
    const withLedger = await rpc(
      fullEnv(),
      "tools/list",
      {},
      {
        ledger: ledger.namespace.getByName("gh-1"),
      },
    );
    const tool = withLedger.result.tools.find((t: Json) => t.name === "multix_usage_summary");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["days", "group_by"]);
    const without = await rpc(fullEnv(), "tools/list");
    expect(without.result.tools.map((t: Json) => t.name)).not.toContain("multix_usage_summary");

    const bad = await callTool(
      fullEnv(),
      "multix_usage_summary",
      { days: 91 },
      {
        ledger: ledger.namespace.getByName("gh-1"),
      },
    );
    expect(bad.isError).toBe(true);
  });

  it("summarises a job run with multix_run through OAuth", async () => {
    const { env, ledger } = await ledgerEnv();
    env.MULTIX_JOBS = fakeNamespace(liveTimes(ledger.namespace)).namespace;
    env.MULTIX_JOB_QUOTA = fakeQuotaNamespace();
    const browser = newBrowser(env, githubFetch(OCTOCAT).fetch);
    const token = await authorizeAndGetToken(browser, await registerClient(browser));

    const listed = await mcpResult(await mcpCall(browser, token, "tools/list"));
    expect(listed.tools.map((t: Json) => t.name)).toContain("multix_usage_summary");

    const run = await mcpResult(
      await mcpCall(browser, token, "tools/call", {
        name: "multix_run",
        arguments: { command: "gemini generate", options: { prompt: "a secret prompt" } },
      }),
    );
    expect(run.structuredContent.status).toBe("succeeded");

    const result = await mcpResult(
      await mcpCall(browser, token, "tools/call", {
        name: "multix_usage_summary",
        arguments: { days: 7, group_by: "source" },
      }),
    );
    expect(result.isError).toBeFalsy();
    const summary = result.structuredContent;
    expect(summary.days).toBe(7);
    expect(summary.totals).toMatchObject({
      operations: 1,
      succeeded: 1,
      known_cost_usd: 0,
      unknown_cost_operations: 1,
    });
    expect(summary.group_by).toBe("source");
    expect(summary.groups.map((g: Json) => g.key)).toEqual(["mcp"]);
    expect(summary.budgets).toEqual([]);
    expect(summary.note).toContain("not in known_cost_usd");
    expect(JSON.stringify(result)).not.toContain("secret prompt");

    // Without the ledger binding the tool is not offered.
    env.MULTIX_LEDGER = undefined;
    const bare = await mcpResult(await mcpCall(browser, token, "tools/list"));
    expect(bare.tools.map((t: Json) => t.name)).not.toContain("multix_usage_summary");
  });
});
