import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../src/agent/history-store.js";
import { registerHistoryCommands } from "../../src/commands/agent/history-command.js";
import {
  SYNC_BATCH_SIZE,
  formatSyncSummary,
  resolveRemoteUrl,
  syncHistory,
  toImportEntry,
  validateProject,
} from "../../src/commands/agent/history-sync.js";
import { ConfigError, ValidationError } from "../../src/core/errors.js";

const KEY = "mxk_test_secret_key_value_123456";
let dir: string;
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

function entry(i: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    v: 1,
    id: `h_${(1_700_000_000_000 + i).toString(36)}abcd`,
    ts: new Date(Date.now() - 1000).toISOString(),
    duration_ms: 1200,
    cwd: "/home/alice/secret-project",
    version: "1.2.3",
    command: "fal image",
    provider: "fal",
    model: "fal-ai/flux",
    argv: ["fal", "image", "private prompt text", "--api-key", "[redacted]"],
    ok: false,
    exit_code: 4,
    error: { code: "RATE_LIMITED", message: "quota for alice@example.com exceeded" },
    outputs: [
      {
        path: "/home/alice/secret-project/client-logo.PNG",
        bytes: 2048,
        mime: "image/png",
        sha256: "ab".repeat(32),
      },
      { path: "/home/alice/noext", bytes: 10 },
    ],
    usage: { cost_usd: 0.04, credits: 2, tokens: { input: 10, output: 5 } },
    http: { requests: 2, errors: 1, ms: 300 },
    provider_ids: ["req-1"],
    ...over,
  };
}

function writeLedger(entries: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, "history.jsonl"),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`,
  );
}

type Sent = { url: string; headers: Record<string, string>; body: { entries: unknown[] } };

function mockImport(status = 200, reply?: (body: { entries: unknown[] }) => unknown): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { entries: unknown[] };
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
    const payload = reply
      ? reply(body)
      : { accepted: body.entries.length - 1, duplicates: 1, rejected: [] };
    return new Response(JSON.stringify(status === 200 ? payload : { error: "nope" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-sync-"));
  process.env.MULTIX_HISTORY_FILE = path.join(dir, "history.jsonl");
  process.env.MULTIX_API_KEY = KEY;
  Reflect.deleteProperty(process.env, "MULTIX_REMOTE_URL");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("toImportEntry", () => {
  it("drops argv, cwd, error message and output paths", () => {
    const source = entry(1);
    const mapped = toImportEntry(source);
    expect(mapped).toEqual({
      id: source.id,
      ts: source.ts,
      duration_ms: 1200,
      version: "1.2.3",
      command: "fal image",
      provider: "fal",
      model: "fal-ai/flux",
      ok: false,
      exit_code: 4,
      error_code: "RATE_LIMITED",
      outputs: [
        { ext: "png", bytes: 2048, mime: "image/png", sha256: "ab".repeat(32) },
        { bytes: 10 },
      ],
      usage: { cost_usd: 0.04, credits: 2, tokens: { input: 10, output: 5 } },
      http: { requests: 2, errors: 1, ms: 300 },
      provider_ids: ["req-1"],
    });
    const text = JSON.stringify(mapped);
    for (const leak of ["alice", "private prompt", "client-logo", "argv", "cwd", "message"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("skips dry runs, entries without id and local commands", () => {
    expect(toImportEntry(entry(1, { dry_run: true }))).toBeUndefined();
    expect(toImportEntry(entry(1, { id: undefined as unknown as string }))).toBeUndefined();
    expect(toImportEntry(entry(1, { provider: "" }))).toBeUndefined();
    expect(toImportEntry(entry(1, { ts: "yesterday" }))).toBeUndefined();
  });
});

describe("option validation", () => {
  it("accepts https and local http, rejects the rest", () => {
    expect(resolveRemoteUrl()).toBe("https://multix.zuey.me");
    expect(resolveRemoteUrl("https://example.com/")).toBe("https://example.com");
    expect(resolveRemoteUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(resolveRemoteUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    process.env.MULTIX_REMOTE_URL = "https://env.example.com";
    expect(resolveRemoteUrl()).toBe("https://env.example.com");
    for (const bad of [
      "http://example.com",
      "ftp://example.com",
      "not a url",
      "https://user:pw@example.com",
      "https://example.com/api",
      "https://example.com/?x=1",
    ]) {
      expect(() => resolveRemoteUrl(bad), bad).toThrow(ValidationError);
    }
  });

  it("validates --project", () => {
    expect(validateProject("team-a.v2_x")).toBe("team-a.v2_x");
    expect(() => validateProject("")).toThrow(ValidationError);
    expect(() => validateProject("a b")).toThrow(ValidationError);
    expect(() => validateProject("x".repeat(65))).toThrow(ValidationError);
  });

  it("errors clearly when MULTIX_API_KEY is missing", async () => {
    Reflect.deleteProperty(process.env, "MULTIX_API_KEY");
    writeLedger([entry(1)]);
    const sent = mockImport();
    await expect(syncHistory({})).rejects.toThrow(ConfigError);
    await expect(syncHistory({})).rejects.toThrow(/MULTIX_API_KEY is not set/);
    expect(sent).toHaveLength(0);
  });

  it("rejects an invalid --since", async () => {
    await expect(syncHistory({ since: "soon" })).rejects.toThrow(ValidationError);
  });
});

describe("syncHistory", () => {
  it("dry run sends nothing and reports counts with a redacted sample", async () => {
    writeLedger([entry(1), entry(2, { dry_run: true }), entry(3)]);
    const sent = mockImport();
    const s = await syncHistory({ dryRun: true });
    expect(sent).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(s).toMatchObject({ dry_run: true, total: 3, entries: 2, skipped: 1, batches: 1 });
    expect(s.sample?.id).toBe(entry(1).id);
    const text = formatSyncSummary(s).join("\n");
    expect(text).toContain("would send 2 of 3 runs");
    expect(text).not.toContain("alice");
  });

  it("batches at 500, sends the bearer key and project, and sums the results", async () => {
    const all = Array.from({ length: SYNC_BATCH_SIZE * 2 + 3 }, (_, i) => entry(i));
    writeLedger(all);
    const sent = mockImport(200, (body) => ({
      accepted: body.entries.length - 1,
      duplicates: 1,
      rejected: [{ id: "h_x", reason: "bad" }],
    }));
    const s = await syncHistory({ project: "team-a", url: "https://srv.example.com" });
    expect(sent.map((r) => r.body.entries.length)).toEqual([500, 500, 3]);
    expect(sent[0]?.url).toBe("https://srv.example.com/api/v1/usage/import");
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.body).toMatchObject({ project: "team-a" });
    expect(JSON.stringify(sent.map((r) => r.body))).not.toContain("alice");
    expect(s).toMatchObject({ entries: 1003, batches: 3, accepted: 1000, duplicates: 3 });
    expect(s.rejected).toHaveLength(3);
    expect(formatSyncSummary(s)[0]).toContain("1000 accepted, 3 duplicates, 3 rejected");
  });

  it("applies --since", async () => {
    writeLedger([entry(1, { ts: "2020-01-01T00:00:00.000Z" }), entry(2)]);
    const sent = mockImport();
    const s = await syncHistory({ since: "1d" });
    expect(s.total).toBe(1);
    expect(sent[0]?.body.entries).toHaveLength(1);
  });

  it("turns 401/403 into a key error without printing the key", async () => {
    writeLedger([entry(1)]);
    for (const status of [401, 403]) {
      mockImport(status);
      const err = await syncHistory({}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).toContain(`HTTP ${status}`);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
  });

  it("rejects a malformed server reply", async () => {
    writeLedger([entry(1)]);
    mockImport(200, () => ({ ok: true }));
    await expect(syncHistory({})).rejects.toThrow(/Unexpected response/);
  });

  it("reports nothing to sync without calling the server", async () => {
    const sent = mockImport();
    const s = await syncHistory({});
    expect(sent).toHaveLength(0);
    expect(formatSyncSummary(s)[0]).toContain("Nothing to sync");
  });
});

describe("history command registration", () => {
  it("runs sync as a subcommand and keeps list as the default", async () => {
    writeLedger([entry(1)]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerHistoryCommands(program);
    await program.parseAsync(["node", "multix", "history", "sync", "--dry-run"]);
    expect(log.mock.calls.flat().join("\n")).toContain("Dry run: would send 1 of 1 runs");
    log.mockClear();
    const p2 = new Command().exitOverride();
    registerHistoryCommands(p2);
    await p2.parseAsync(["node", "multix", "history"]);
    expect(log.mock.calls.flat().join("\n")).toContain(entry(1).id);
  });
});
