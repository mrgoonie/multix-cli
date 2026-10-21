import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HistoryEntry,
  appendHistory,
  findHistory,
  newHistoryId,
  parseSince,
  readHistory,
  redactArgv,
} from "../../../src/agent/history-store.js";
import { historyStats } from "../../../src/commands/agent/history-command.js";

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    v: 1,
    id: newHistoryId(),
    ts: new Date().toISOString(),
    duration_ms: 1000,
    cwd: "/tmp",
    version: "0.0.0",
    command: "fal image",
    provider: "fal",
    argv: ["fal", "image", "a cat"],
    ok: true,
    exit_code: 0,
    ...over,
  };
}

describe("redactArgv", () => {
  it("hides values of secret-looking options in both forms", () => {
    expect(redactArgv(["run", "--api-key", "sk-1", "--token=abc", "--prompt", "hi"])).toEqual([
      "run",
      "--api-key",
      "[redacted]",
      "--token=[redacted]",
      "--prompt",
      "hi",
    ]);
  });
});

describe("redactArgv URLs and ids", () => {
  it("hides signed URL queries but keeps image ids and plain URLs", () => {
    expect(
      redactArgv([
        "--image",
        "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=abc&X-Amz-Expires=60",
        "--image-key",
        "img-123",
        "--ref",
        "https://example.com/a.png",
      ]),
    ).toEqual([
      "--image",
      "https://bucket.s3.amazonaws.com/a.png?[redacted]",
      "--image-key",
      "img-123",
      "--ref",
      "https://example.com/a.png",
    ]);
  });
});

describe("parseSince", () => {
  it("parses relative ages and ISO dates", () => {
    expect(parseSince("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(parseSince("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(() => parseSince("yesterday")).toThrow(/Invalid --since/);
  });
});

describe("history file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-history-"));
    process.env.MULTIX_HISTORY = "1";
    process.env.MULTIX_HISTORY_FILE = path.join(dir, "h.jsonl");
  });
  afterEach(() => {
    process.env.MULTIX_HISTORY = "0";
    Reflect.deleteProperty(process.env, "MULTIX_HISTORY_FILE");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends entries, skips malformed lines, and finds by id, prefix and last-N", () => {
    const a = entry({ id: "h_aaa1" });
    const b = entry({ id: "h_bbb2", ok: false, exit_code: 4 });
    appendHistory(a);
    fs.appendFileSync(path.join(dir, "h.jsonl"), "not json\n");
    appendHistory(b);
    const all = readHistory();
    expect(all.map((e) => e.id)).toEqual(["h_aaa1", "h_bbb2"]);
    expect(findHistory("last")?.id).toBe("h_bbb2");
    expect(findHistory("last-2")?.id).toBe("h_aaa1");
    expect(findHistory("h_aaa")?.id).toBe("h_aaa1");
    expect(findHistory("h_zzz")).toBeUndefined();
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, "h.jsonl")).mode & 0o777).toBe(0o600);
    }
  });

  it("writes nothing when MULTIX_HISTORY=0", () => {
    process.env.MULTIX_HISTORY = "0";
    appendHistory(entry({}));
    expect(fs.existsSync(path.join(dir, "h.jsonl"))).toBe(false);
  });
});

describe("historyStats", () => {
  it("aggregates success rate, durations, cost, credits and tokens; skips dry runs", () => {
    const rows = historyStats(
      [
        entry({ duration_ms: 1000, usage: { cost_usd: 0.003 } }),
        entry({ duration_ms: 3000, ok: false, usage: { cost_usd: 0.001, credits: 5 } }),
        entry({
          provider: "gemini",
          model: "gemini-x",
          usage: { tokens: { input: 10, output: 5 } },
        }),
        entry({ dry_run: true }),
      ],
      "provider",
    );
    expect(rows[0]).toMatchObject({
      provider: "fal",
      runs: 2,
      success_rate: 0.5,
      cost_usd: 0.004,
      credits: 5,
    });
    expect(rows[1]).toMatchObject({ provider: "gemini", runs: 1, tokens: 15 });
  });
});
