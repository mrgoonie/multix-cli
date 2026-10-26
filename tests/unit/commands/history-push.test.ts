import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HistoryEntry, newHistoryId } from "../../../src/agent/history-store.js";
import { registerHistoryCommands } from "../../../src/commands/agent/history-command.js";
import {
  DEFAULT_REMOTE_URL,
  pushHistory,
  pushableEntries,
  resolveApiKey,
  resolveRemoteUrl,
  toImportEntry,
} from "../../../src/commands/agent/history-push.js";
import { ConfigError, HttpError } from "../../../src/core/errors.js";
import { PROJECT_ENV_EXCLUDED, isProjectEnvName } from "../../../src/project-env-names.js";

const KEY = "mxk_test_0123456789abcdef";
const SHA = "a".repeat(64);

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    v: 1,
    id: newHistoryId(),
    ts: new Date().toISOString(),
    duration_ms: 1200,
    cwd: "/home/alice/secret-project",
    version: "1.2.3",
    command: "fal image",
    provider: "fal",
    model: "fal-ai/flux/schnell",
    argv: ["fal", "image", "a portrait of my neighbour", "--api-key", "[redacted]"],
    ok: false,
    exit_code: 4,
    error: { code: "RATE_LIMITED", message: "HTTP 429 for prompt 'a portrait of my neighbour'" },
    outputs: [
      {
        path: "/home/alice/secret-project/out/img.webp",
        bytes: 2048,
        mime: "image/webp",
        sha256: SHA,
      },
    ],
    usage: { tokens: { input: 10, output: 20 }, cost_usd: 0.003, metrics: { "timings.ms": 900 } },
    http: { requests: 2, errors: 1, ms: 950 },
    provider_ids: ["req_123"],
    ...over,
  };
}

describe("toImportEntry", () => {
  it("keeps measurements and drops argv, cwd, error message and output paths", () => {
    const out = toImportEntry(entry());
    expect(out).toEqual({
      id: out.id,
      ts: out.ts,
      duration_ms: 1200,
      command: "fal image",
      provider: "fal",
      model: "fal-ai/flux/schnell",
      ok: false,
      exit_code: 4,
      error_code: "RATE_LIMITED",
      outputs: [{ bytes: 2048, mime: "image/webp", sha256: SHA }],
      usage: { tokens: { input: 10, output: 20 }, cost_usd: 0.003, metrics: { "timings.ms": 900 } },
      http: { requests: 2, errors: 1, ms: 950 },
      provider_ids: ["req_123"],
      version: "1.2.3",
    });
    const text = JSON.stringify(out);
    for (const secret of [
      "neighbour",
      "alice",
      "secret-project",
      "argv",
      "cwd",
      "path",
      "HTTP 429",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps sha256 only as 64 hex digits", () => {
    const outputs = [
      { path: "/a", bytes: 1, sha256: "xyz" },
      { path: "/b", bytes: 2, sha256: `${"A".repeat(64)}` },
      { path: "/c", bytes: 3, sha256: `${"a".repeat(63)}g` },
    ];
    expect(toImportEntry(entry({ outputs })).outputs).toEqual([
      { bytes: 1 },
      { bytes: 2, sha256: "a".repeat(64) },
      { bytes: 3 },
    ]);
  });

  it("caps provider ids at 10, each at most 128 chars, and drops URLs and paths", () => {
    const ids = [
      "https://cdn.example.com/x.png?token=abc",
      "s3://bucket/key",
      "/tmp/file",
      "x".repeat(129),
      "has space",
      ...Array.from({ length: 12 }, (_, i) => `id_${i}`),
    ];
    const out = toImportEntry(entry({ provider_ids: ids })).provider_ids;
    expect(out).toEqual(Array.from({ length: 10 }, (_, i) => `id_${i}`));
    expect(toImportEntry(entry({ provider_ids: ["y".repeat(128)] })).provider_ids).toEqual([
      "y".repeat(128),
    ]);
  });

  it("omits empty or malformed optional fields", () => {
    const out = toImportEntry(
      entry({
        ok: true,
        exit_code: 0,
        error: undefined,
        outputs: [],
        usage: {},
        http: undefined,
        provider_ids: [],
        model: "https://evil.example/model",
      }),
    );
    for (const k of ["error_code", "outputs", "usage", "http", "provider_ids", "model"]) {
      expect(out, k).not.toHaveProperty(k);
    }
  });

  it("drops an error code that is not a plain code", () => {
    const out = toImportEntry(entry({ error: { code: "my prompt text", message: "x" } }));
    expect(out).not.toHaveProperty("error_code");
  });
});

describe("pushableEntries", () => {
  it("skips dry runs and malformed lines", () => {
    const good = entry();
    const list = [good, entry({ dry_run: true }), { ...entry(), ts: "nope" }];
    expect(pushableEntries(list as HistoryEntry[])).toEqual([good]);
  });
});

describe("resolveRemoteUrl / resolveApiKey", () => {
  it("defaults to the hosted server and trims trailing slashes", () => {
    expect(resolveRemoteUrl(undefined, {})).toBe(DEFAULT_REMOTE_URL);
    expect(resolveRemoteUrl(undefined, { MULTIX_REMOTE_URL: "https://x.example/base/" })).toBe(
      "https://x.example/base",
    );
    expect(
      resolveRemoteUrl("https://flag.example", { MULTIX_REMOTE_URL: "https://env.example" }),
    ).toBe("https://flag.example");
  });

  it("requires https except for loopback hosts", () => {
    expect(() => resolveRemoteUrl("http://multix.example", {})).toThrow(ConfigError);
    expect(() => resolveRemoteUrl("ftp://multix.example", {})).toThrow(/https/);
    expect(() => resolveRemoteUrl("not a url", {})).toThrow(/absolute https/);
    expect(() => resolveRemoteUrl("https://u:p@multix.example", {})).toThrow(/credentials/);
    expect(resolveRemoteUrl("http://localhost:8787", {})).toBe("http://localhost:8787");
    expect(resolveRemoteUrl("http://127.0.0.1:8787/", {})).toBe("http://127.0.0.1:8787");
  });

  it("reads the key from MULTIX_API_KEY with an actionable hint when missing", () => {
    expect(resolveApiKey("https://m.example", { MULTIX_API_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(() => resolveApiKey("https://m.example", {})).toThrow(
      /MULTIX_API_KEY is not set\. Create an API key in https:\/\/m\.example\/dashboard/,
    );
  });

  it("refuses both names from a project .env", () => {
    for (const name of ["MULTIX_API_KEY", "MULTIX_REMOTE_URL"]) {
      expect(isProjectEnvName(name, "linux"), name).toBe(false);
      expect(PROJECT_ENV_EXCLUDED.has(name), name).toBe(true);
    }
  });
});

type Call = { url: string; init: RequestInit };

function recordingFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pushHistory", () => {
  it("sends batches of 200 with the bearer key and sums the counts", async () => {
    const entries = Array.from({ length: 450 }, () => toImportEntry(entry()));
    const { fn, calls } = recordingFetch((call) => {
      const n = (JSON.parse(String(call.init.body)) as { entries: unknown[] }).entries.length;
      return json(200, { accepted: n - 1, duplicates: 1, rejected: 0 });
    });
    const summary = await pushHistory(entries, {
      baseUrl: "https://m.example",
      apiKey: KEY,
      fetch: fn,
    });
    expect(calls).toHaveLength(3);
    const sizes = calls.map(
      (c) => (JSON.parse(String(c.init.body)) as { entries: unknown[] }).entries.length,
    );
    expect(sizes).toEqual([200, 200, 50]);
    for (const c of calls) {
      expect(c.url).toBe("https://m.example/api/v1/usage/import");
      expect(c.init.method).toBe("POST");
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    }
    const sentIds = calls.flatMap(
      (c) => (JSON.parse(String(c.init.body)) as { entries: { id: string }[] }).entries,
    );
    expect(sentIds.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(summary).toEqual({ accepted: 447, duplicates: 3, rejected: 0 });
  });

  it("turns 401 into a key error that never shows the key", async () => {
    const { fn } = recordingFetch(() =>
      json(401, { error: { code: "UNAUTHORIZED", message: "unknown key" } }),
    );
    const err = await pushHistory([toImportEntry(entry())], {
      baseUrl: "https://m.example",
      apiKey: KEY,
      fetch: fn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/MULTIX_API_KEY was rejected.*invalid key.*dashboard/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("reports partial progress, then rethrows other HTTP errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fn } = recordingFetch((_c, i) =>
      i === 0 ? json(200, { accepted: 200, duplicates: 0, rejected: 0 }) : json(500, { error: {} }),
    );
    const entries = Array.from({ length: 201 }, () => toImportEntry(entry()));
    await expect(
      pushHistory(entries, { baseUrl: "https://m.example", apiKey: KEY, fetch: fn }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(String(errors.mock.calls[0]?.[0])).toContain("Sent 1 of 2 batches (200 accepted");
    errors.mockRestore();
  });

  it("rejects a response without the counts", async () => {
    const { fn } = recordingFetch(() => json(200, { ok: true }));
    await expect(
      pushHistory([toImportEntry(entry())], {
        baseUrl: "https://m.example",
        apiKey: KEY,
        fetch: fn,
      }),
    ).rejects.toThrow(/Unexpected response/);
  });
});

describe("multix history push", () => {
  let tmp: string;
  let logs: string[];
  let fetchSpy: ReturnType<typeof vi.fn>;

  const runPush = async (...args: string[]) => {
    const program = new Command()
      .name("multix")
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    registerHistoryCommands(program);
    await program.parseAsync(["node", "multix", "history", "push", ...args]);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-push-"));
    const file = path.join(tmp, "history.jsonl");
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const lines = [
      entry({ id: "h_old", ts: old }),
      entry({ id: "h_dry", dry_run: true }),
      entry({ id: "h_one" }),
      entry({ id: "h_two", ok: true, exit_code: 0, error: undefined }),
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    vi.stubEnv("MULTIX_HISTORY_FILE", file);
    vi.stubEnv("MULTIX_API_KEY", KEY);
    vi.stubEnv("MULTIX_REMOTE_URL", "");
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const n = (JSON.parse(String(init?.body)) as { entries: unknown[] }).entries.length;
      return json(200, { accepted: n, duplicates: 0, rejected: 0 });
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pushes runs from the last 30 days, skipping dry runs, and never prints the key", async () => {
    await runPush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://multix.zuey.me/api/v1/usage/import");
    const body = JSON.parse(String(init.body)) as { entries: { id: string }[] };
    expect(body.entries.map((e) => e.id)).toEqual(["h_one", "h_two"]);
    expect(String(init.body)).not.toMatch(/argv|cwd|alice|neighbour/);
    expect(logs.join("\n")).toContain("2 accepted, 0 duplicates, 0 rejected");
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("applies --since and --failed", async () => {
    await runPush("--since", "60d", "--failed");
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["h_old", "h_one"]);
  });

  it("--dry-run prints the count and a redacted sample and sends nothing", async () => {
    vi.stubEnv("MULTIX_API_KEY", "");
    await runPush("--dry-run");
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = logs.join("\n");
    expect(text).toContain("Would send 2 run(s) in 1 request(s) to https://multix.zuey.me");
    expect(text).toContain('"id": "h_one"');
    expect(text).not.toMatch(/argv|cwd|alice|neighbour/);
  });

  it("stops with an actionable error when MULTIX_API_KEY is missing", async () => {
    vi.stubEnv("MULTIX_API_KEY", "");
    await expect(runPush()).rejects.toThrow(
      /MULTIX_API_KEY is not set.*multix\.zuey\.me\/dashboard/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-https --url or MULTIX_REMOTE_URL before sending", async () => {
    await expect(runPush("--url", "http://multix.example")).rejects.toThrow(/https/);
    vi.stubEnv("MULTIX_REMOTE_URL", "http://multix.example");
    await expect(runPush()).rejects.toThrow(/MULTIX_REMOTE_URL must use https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no flag that takes the key", async () => {
    await expect(runPush("--api-key", KEY)).rejects.toThrow(/unknown option/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
