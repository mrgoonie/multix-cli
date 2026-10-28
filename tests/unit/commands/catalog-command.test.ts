/**
 * `multix catalog` through commander: sourced comparison, provider readiness
 * without key values, the rating, review, note, edit and delete loop, the
 * refusals for shared scope and secrets, usage over a temp run ledger, and
 * recommendations. Dates are fixed, the fetch global throws, and every file
 * the command reads or writes lives in a temp directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../../src/agent/history-store.js";
import { run } from "../../../src/agent/run-state.js";
import { registerCommands } from "../../../src/commands/index.js";
import { ValidationError } from "../../../src/core/errors.js";

const REF = "fal:bytedance/seedance-2.0/text-to-video";
const FAL_KEY_VALUE = "fal-test-value-not-for-output";
const OPENAI_KEY_VALUE = "sk-openai-test-value-0123456789abcdef";

let tmp: string;
let stdout: string[];

interface Quote {
  ref: string;
  amount: number | null;
  rank?: number;
  status?: string;
}

interface ProviderRow {
  provider: string;
  ready: boolean | null;
}

interface Json {
  comparable: Quote[];
  not_comparable: Quote[];
  recommendations: Array<{
    ref: string;
    rank: number;
    caveats: string[];
    evidence: { key_ready: boolean | null; own_note: string | null; price: { status: string } };
  }>;
  ranking_basis: string[];
  rows: Array<{
    key: string;
    operations: number;
    runs: number;
    cost: { actual_usd: number | null };
  }>;
  totals: { operations: number };
  quotes?: Array<{ status: string; amount: number | null }>;
  entries: Array<{
    id: string;
    kind: string;
    score?: number;
    text?: string;
    verdict?: string;
    verified_usage?: unknown;
    content_trust: string;
  }>;
  summary: { count: number };
  verified_usage?: { history_id: string; job_id?: string };
  id: string;
  kind: string;
  score?: number;
  text?: string;
  scope: string;
  deleted?: string;
  ratings: { count: number };
  feedback: unknown[];
  usage: unknown;
}

function historyEntry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    v: 1,
    id: "h_x",
    ts: "2026-10-27T10:00:00.000Z",
    duration_ms: 4000,
    cwd: "/work",
    version: "0.0.0",
    command: "fal video",
    provider: "fal",
    argv: [],
    ok: true,
    exit_code: 0,
    ...over,
  };
}

function writeHistory(entries: HistoryEntry[]): void {
  fs.writeFileSync(
    path.join(tmp, "history.jsonl"),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

function newProgram(): Command {
  const program = new Command().name("multix").enablePositionalOptions();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerCommands(program);
  return program;
}

/** Runs `multix catalog ...` and parses the one JSON document it printed. */
async function catalog<T = Json>(...args: string[]): Promise<T> {
  run.json = true;
  stdout = [];
  await newProgram().parseAsync(["node", "multix", "catalog", ...args]);
  return JSON.parse(stdout.join("\n")) as T;
}

/** Runs `multix catalog ...` in text mode and returns the printed lines. */
async function catalogText(...args: string[]): Promise<string> {
  run.json = false;
  stdout = [];
  await newProgram().parseAsync(["node", "multix", "catalog", ...args]);
  return stdout.join("\n");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-catalog-cmd-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
  vi.stubEnv("MULTIX_CATALOG_FEEDBACK_FILE", path.join(tmp, "feedback.json"));
  vi.stubEnv("MULTIX_HISTORY_FILE", path.join(tmp, "history.jsonl"));
  vi.stubEnv("FAL_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Catalog reads never touch the network; any call here is a test failure.
  vi.stubGlobal("fetch", () => {
    throw new Error("catalog commands must not call the network");
  });
});

afterEach(() => {
  run.json = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("multix catalog compare", () => {
  it("compares seedance-2.0 at 720p for 10 s: BytePlus first at $1.5, then fal at $3.034 twice", async () => {
    const result = await catalog(
      "compare",
      "seedance-2.0",
      "--resolution",
      "720p",
      "--duration",
      "10",
    );
    expect(result.comparable.map((q) => [q.ref, q.amount, q.rank])).toEqual([
      ["byteplus:dreamina-seedance-2-0-260128", 1.5, 1],
      ["fal:bytedance/seedance-2.0/image-to-video", 3.034, 2],
      ["fal:bytedance/seedance-2.0/text-to-video", 3.034, 3],
    ]);
    expect(result.comparable.some((q) => q.ref.includes("fast"))).toBe(false);
  });

  it("prints the ranking in text mode with the basis and the note", async () => {
    const text = await catalogText(
      "compare",
      "seedance-2.0",
      "--resolution",
      "720p",
      "--duration",
      "10",
    );
    expect(text).toContain(
      "#1 byteplus:dreamina-seedance-2-0-260128  $1.5  (10 s x 0.15 USD/video_second)",
    );
    expect(text).toContain("List prices only");
  });

  it("says nothing is quoted when no duration is given, instead of ranking $0", async () => {
    const result = await catalog("compare", "seedance-2.0", "--resolution", "720p");
    expect(result.comparable).toEqual([]);
    expect(result.not_comparable.every((q) => q.amount === null)).toBe(true);
  });
});

describe("multix catalog providers", () => {
  it("reports readiness and never prints a key value, in JSON or text", async () => {
    vi.stubEnv("FAL_KEY", FAL_KEY_VALUE);
    vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY_VALUE);
    const providers = await catalog<ProviderRow[]>("providers");
    expect(providers.find((p) => p.provider === "fal")?.ready).toBe(true);
    expect(providers.find((p) => p.provider === "openai")?.ready).toBe(true);
    expect(JSON.stringify(providers)).not.toContain(FAL_KEY_VALUE);
    expect(JSON.stringify(providers)).not.toContain(OPENAI_KEY_VALUE);

    const text = await catalogText("providers");
    expect(text).not.toContain(FAL_KEY_VALUE);
    expect(text).not.toContain(OPENAI_KEY_VALUE);
    expect(text).toMatch(/fal\s+ready/);
  });

  it("marks a provider without its key as not ready", async () => {
    const providers = await catalog<ProviderRow[]>("providers");
    expect(providers.find((p) => p.provider === "fal")?.ready).toBe(false);
  });
});

describe("multix catalog rate, feedback, edit and delete", () => {
  it("rates an offering, lists it, edits it and deletes it", async () => {
    const saved = await catalog(
      "rate",
      REF,
      "--score",
      "4",
      "--use-case",
      "product-ugc",
      "--aspect",
      "quality=5",
      "--tag",
      "ugc",
    );
    expect(saved).toMatchObject({
      kind: "rating",
      score: 4,
      scope: "private",
      content_trust: "user-authored",
    });

    const listed = await catalog("feedback");
    expect(listed.summary.count).toBe(1);
    expect(listed.entries.map((e) => e.id)).toEqual([saved.id]);

    const byRef = await catalog("feedback", REF, "--use-case", "product-ugc", "--kind", "rating");
    expect(byRef.entries).toHaveLength(1);
    expect((await catalog("feedback", REF, "--kind", "note")).entries).toEqual([]);

    const edited = await catalog(
      "edit",
      saved.id,
      "--score",
      "5",
      "--text",
      "better on the second try",
    );
    expect(edited).toMatchObject({ id: saved.id, score: 5, text: "better on the second try" });
    const after = await catalog("feedback", REF);
    expect(after.entries[0]).toMatchObject({ score: 5, text: "better on the second try" });

    expect(await catalog("delete", saved.id)).toEqual({ deleted: saved.id });
    expect((await catalog("feedback")).entries).toEqual([]);
    await expect(catalog("delete", saved.id)).rejects.toThrow(ValidationError);
  });

  it("keeps the rating and tags an edit did not change", async () => {
    const saved = await catalog(
      "rate",
      REF,
      "--score",
      "3",
      "--use-case",
      "product-ugc",
      "--tag",
      "fast",
    );
    const edited = await catalog("edit", saved.id, "--text", "fine");
    expect(edited).toMatchObject({ score: 3, text: "fine" });
  });

  it("prints the saved entry in text mode", async () => {
    const text = await catalogText("rate", REF, "--score", "4");
    expect(text).toMatch(
      /^Saved rating fb_\S+ for fal:bytedance\/seedance-2\.0\/text-to-video \(private\)/,
    );
  });

  it("refuses a shared scope", async () => {
    await expect(catalog("rate", REF, "--score", "4", "--scope", "public")).rejects.toThrow(
      /--scope public is not available yet/,
    );
    expect((await catalog("feedback")).entries).toEqual([]);
  });

  it("refuses a review that contains an API key and stores nothing", async () => {
    await expect(
      catalog("review", REF, "--text", "my key sk-abcdefghijklmnopqrstuvwxyz"),
    ).rejects.toThrow(/looks like it contains an API key/);
    expect((await catalog("feedback")).entries).toEqual([]);
  });

  it("refuses a rating for an offering that is neither in the catalogue nor in history", async () => {
    await expect(catalog("rate", "fal:nobody/nothing", "--score", "4")).rejects.toThrow(
      /not in the catalogue or your history/,
    );
  });

  it("requires a score for a rating", async () => {
    await expect(catalog("rate", REF)).rejects.toThrow(/--score/);
  });

  it("records a note that marks an offering avoid for a use case", async () => {
    const note = await catalog(
      "note",
      REF,
      "--verdict",
      "avoid",
      "--use-case",
      "product-ugc",
      "--weakness",
      "slow queue",
    );
    expect(note).toMatchObject({ kind: "note", verdict: "avoid" });
  });

  it("refuses a rating that claims a run which did not complete", async () => {
    writeHistory([
      historyEntry({
        id: "h_failed",
        ok: false,
        exit_code: 1,
        error: { code: "PROVIDER_ERROR", message: "boom" },
        job: { provider: "fal", id: "req_failed", attempt: 1 },
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
    ]);
    await expect(catalog("rate", REF, "--score", "4", "--job", "req_failed")).rejects.toThrow(
      /did not complete; only completed runs verify usage/,
    );
  });

  it("marks a rating as verified usage when it names a completed run of the offering", async () => {
    writeHistory([
      historyEntry({
        id: "h_done",
        job: { provider: "fal", id: "req_done", attempt: 1 },
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
    ]);
    const saved = await catalog("rate", REF, "--score", "4", "--job", "req_done");
    expect(saved.verified_usage).toMatchObject({ history_id: "h_done", job_id: "req_done" });
  });
});

describe("multix catalog rate --job for an async job", () => {
  it("verifies usage when only the submit names the model and the status poll completed", async () => {
    const job = { provider: "fal", id: "req_async", attempt: 1 };
    writeHistory([
      historyEntry({
        id: "h_submit",
        ts: "2026-10-27T10:00:00.000Z",
        job,
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
      historyEntry({ id: "h_status", ts: "2026-10-27T10:01:00.000Z", command: "fal status", job }),
    ]);
    const saved = await catalog("rate", REF, "--score", "4", "--job", "req_async");
    expect(saved.verified_usage).toMatchObject({ history_id: "h_status", job_id: "req_async" });
  });

  it("matches an exact provider job id before a history id prefix", async () => {
    writeHistory([
      historyEntry({
        id: "h_other_run",
        ts: "2026-10-27T11:00:00.000Z",
        provider: "byteplus",
        model_resolved: "dreamina-seedance-2-0-260128",
      }),
      historyEntry({
        id: "h_fal_run",
        ts: "2026-10-27T10:00:00.000Z",
        job: { provider: "fal", id: "h_", attempt: 1 },
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
    ]);
    const saved = await catalog("rate", REF, "--score", "4", "--job", "h_");
    expect(saved.verified_usage).toMatchObject({ history_id: "h_fal_run" });
  });
});

describe("multix catalog project feedback", () => {
  it("applies a project note only in the project that wrote it", async () => {
    const a = path.join(tmp, "a", "app");
    const b = path.join(tmp, "b", "app");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(a);
    await catalog("note", REF, "--verdict", "avoid", "--use-case", "ugc", "--scope", "project");
    expect((await catalog("show", REF)).feedback).toHaveLength(1);
    cwd.mockReturnValue(b);
    expect((await catalog("show", REF)).feedback).toHaveLength(0);
  });
});

describe("multix catalog usage", () => {
  beforeEach(() => {
    writeHistory([
      historyEntry({
        id: "h_fal_submit",
        ts: "2026-10-27T10:00:00.000Z",
        model_requested: "bytedance/seedance-2.0/text-to-video",
        model_resolved: "bytedance/seedance-2.0/text-to-video",
        job: { provider: "fal", id: "req_1", attempt: 1 },
      }),
      historyEntry({
        id: "h_fal_poll",
        ts: "2026-10-27T10:00:30.000Z",
        command: "fal status",
        job: { provider: "fal", id: "req_1", attempt: 1 },
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
      historyEntry({
        id: "h_byte",
        ts: "2026-10-27T11:00:00.000Z",
        command: "byteplus video",
        provider: "byteplus",
        model_resolved: "dreamina-seedance-2-0-260128",
        cost: {
          schema: "multix.cost/v1",
          operation_id: "op-byte-1",
          role: "charge",
          status: "settled",
          currency: "USD",
          provider_reported: { cost_usd: 0.5, credits: null },
          actual_usd: 0.5,
          actual_source: "provider_reported",
          variance_usd: null,
          at: "2026-10-27T11:00:05.000Z",
        },
      }),
      historyEntry({
        id: "h_old",
        ts: "2026-01-02T00:00:00.000Z",
        command: "fal video",
        model_resolved: "bytedance/seedance-2.0/text-to-video",
      }),
    ]);
  });

  it("groups by model by default, one operation per job with its runs", async () => {
    const report = await catalog("usage");
    const fal = report.rows.find((r) => r.key === REF);
    expect(fal).toMatchObject({ operations: 2, runs: 3 });
    const byte = report.rows.find((r) => r.key === "byteplus:dreamina-seedance-2-0-260128");
    expect(byte?.cost.actual_usd).toBe(0.5);
  });

  it("filters by provider and by age", async () => {
    const fal = await catalog("usage", "--provider", "fal");
    expect(fal.rows.map((r) => r.key)).toEqual([REF]);
    const recent = await catalog("usage", "--since", "7d");
    expect(recent.totals.operations).toBe(2);
  });

  it("groups by provider when asked", async () => {
    const report = await catalog("usage", "--by", "provider");
    expect(report.rows.map((r) => r.key).sort()).toEqual(["byteplus", "fal"]);
  });

  it("refuses an unknown grouping", async () => {
    await expect(catalog("usage", "--by", "bogus")).rejects.toThrow(
      /--by must be provider, model, task or command/,
    );
  });

  it("says no runs match a filter that excludes all of them", async () => {
    const text = await catalogText("usage", "--provider", "openai");
    expect(text).toBe("No runs recorded for this filter.");
  });
});

describe("multix catalog recommend", () => {
  it("suggests video offerings with reasons, caveats and evidence", async () => {
    vi.stubEnv("FAL_KEY", FAL_KEY_VALUE);
    const result = await catalog("recommend", "--task", "video", "--limit", "5");
    expect(result.ranking_basis).toHaveLength(7);
    expect(result.recommendations).toHaveLength(5);
    expect(result.recommendations.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    const fal = result.recommendations.find((r) => r.ref.startsWith("fal:"));
    expect(fal?.evidence.key_ready).toBe(true);
  });

  it("quotes candidates when a configuration beyond the task is given", async () => {
    const result = await catalog(
      "recommend",
      "--task",
      "video",
      "--resolution",
      "720p",
      "--duration",
      "10",
      "--limit",
      "10",
    );
    const byteplus = result.recommendations.find(
      (r) => r.ref === "byteplus:dreamina-seedance-2-0-260128",
    );
    expect(byteplus?.evidence.price).toMatchObject({ status: "quoted", amount: 1.5 });
  });

  it("puts a candidate the user marked avoid for the use case last", async () => {
    await catalog("note", REF, "--verdict", "avoid", "--use-case", "product-ugc");
    const result = await catalog(
      "recommend",
      "--task",
      "video",
      "--use-case",
      "product-ugc",
      "--limit",
      "100",
    );
    const last = result.recommendations.at(-1);
    expect(last?.ref).toBe(REF);
    expect(last?.evidence.own_note).toBe("avoid");
  });

  it("requires a task", async () => {
    await expect(catalog("recommend")).rejects.toThrow(/--task is required/);
  });
});

describe("multix catalog show and models", () => {
  it("shows one offering with its quotes for a configuration", async () => {
    const result = await catalog("show", REF, "--resolution", "720p", "--duration", "10");
    expect(result.quotes?.map((q) => [q.status, q.amount])).toEqual([
      ["quoted", 3.034],
      ["not_equivalent", null],
    ]);
    expect(result.usage).toBeNull();
    expect(result.ratings.count).toBe(0);
  });

  it("refuses a ref that is not a provider:model pair", async () => {
    await expect(catalog("show", "no-colon-here")).rejects.toThrow(/Use <provider>:<model>/);
  });

  it("refuses a ref that is not in the catalogue", async () => {
    await expect(catalog("show", "fal:nobody/nothing")).rejects.toThrow(/not in the catalogue/);
  });
});
