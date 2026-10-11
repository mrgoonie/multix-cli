import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError, isTransientHttpError, pollUntil } from "../../../src/core/async-poll.js";
import { ConfigError, HttpError, ValidationError } from "../../../src/core/errors.js";
import { fetchJson, parseRetryAfter } from "../../../src/core/fetch-json.js";
import { parseJsonInput } from "../../../src/core/json-input.js";
import { redactUrl } from "../../../src/core/redact.js";

const WORKER_SAFE_MODULES = ["redact.ts", "fetch-json.ts", "async-poll.ts", "errors.ts"];

describe("worker-safe core modules", () => {
  it.each(WORKER_SAFE_MODULES)("%s has no node:* imports", (file) => {
    const src = fs.readFileSync(path.resolve("src/core", file), "utf8");
    expect(src).not.toMatch(/(from\s+|import\s*\(?\s*)["']node:/);
  });
});

describe("redactUrl", () => {
  it("strips query strings carrying keys or signatures", () => {
    expect(redactUrl("https://api.example.com/v1/models?key=AIzaSECRET")).toBe(
      "https://api.example.com/v1/models?[redacted]",
    );
    expect(redactUrl("https://cdn.example.com/out.mp4?X-Amz-Signature=abc#t=1")).toBe(
      "https://cdn.example.com/out.mp4?[redacted]",
    );
  });

  it("leaves plain URLs unchanged", () => {
    expect(redactUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models",
    );
  });

  it("never echoes opaque data: payloads", () => {
    expect(redactUrl("data:image/png;base64,SECRETPAYLOAD")).toBe("data:[redacted]");
  });

  it("handles non-URL strings", () => {
    expect(redactUrl("not a url?token=1")).toBe("not a url?[redacted]");
  });
});

describe("HttpError", () => {
  it("never puts the query string in its message but keeps the raw url", () => {
    const e = new HttpError(500, "boom", "https://x.test/a?key=SECRET123");
    expect(e.message).not.toContain("SECRET123");
    expect(e.message).toContain("https://x.test/a");
    expect(e.url).toBe("https://x.test/a?[redacted]");
    expect(e.rawUrl).toBe("https://x.test/a?key=SECRET123");
    expect(JSON.stringify(e)).not.toContain("SECRET123");
  });
});

describe("parseRetryAfter", () => {
  it("parses delta seconds", () => {
    expect(parseRetryAfter("7")).toBe(7000);
  });
  it("parses an HTTP date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });
  it("returns undefined for garbage", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("fetchJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses an injected fetch and sends JSON", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await fetchJson<{ ok: boolean }>({
      url: "https://api.test/x",
      method: "POST",
      body: { a: 1 },
      headers: { authorization: "Bearer t" },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0]?.init?.body).toBe('{"a":1}');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("exposes Retry-After on 429", async () => {
    await expect(
      fetchJson({
        url: "https://api.test/x",
        fetch: async () =>
          new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it("wraps invalid JSON bodies in HttpError", async () => {
    await expect(
      fetchJson({
        url: "https://api.test/x",
        fetch: async () => new Response("<html>", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("returns undefined for empty bodies", async () => {
    await expect(
      fetchJson({
        url: "https://api.test/x",
        fetch: async () => new Response(null, { status: 204 }),
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to globalThis.fetch", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await expect(fetchJson({ url: "https://api.test/x" })).resolves.toEqual({});
  });
});

describe("pollUntil", () => {
  const noSleep = async () => {};

  it("returns the terminal state", async () => {
    const states = ["starting", "processing", "succeeded"];
    let i = 0;
    const seen: string[] = [];
    const out = await pollUntil({
      fetchStatus: async () => states[i++] as string,
      isTerminal: (s) => s === "succeeded" || s === "failed",
      timeoutMs: 60_000,
      sleep: noSleep,
      onPoll: (s) => seen.push(s),
    });
    expect(out).toBe("succeeded");
    expect(seen).toEqual(states);
  });

  it("retries transient errors and honours Retry-After", async () => {
    let i = 0;
    const delays: number[] = [];
    const out = await pollUntil({
      fetchStatus: async () => {
        i++;
        if (i === 1) throw new HttpError(429, "rate", "https://x", 1234);
        if (i === 2) throw new HttpError(503, "down", "https://x");
        return "done";
      },
      isTerminal: (s) => s === "done",
      timeoutMs: 60_000,
      jitter: false,
      intervalMs: 100,
      minIntervalMs: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(out).toBe("done");
    expect(delays[0]).toBe(1234);
    expect(delays[1]).toBe(150);
  });

  it("never busy-loops on Retry-After: 0", async () => {
    let i = 0;
    const delays: number[] = [];
    await pollUntil({
      fetchStatus: async () => {
        i++;
        if (i === 1) throw new HttpError(429, "rate", "https://x", 0);
        return "done";
      },
      isTerminal: (s) => s === "done",
      timeoutMs: 60_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays[0]).toBeGreaterThanOrEqual(500);
  });

  it("passes the remaining budget to fetchStatus", async () => {
    let seen = 0;
    await pollUntil({
      fetchStatus: async ({ remainingMs }) => {
        seen = remainingMs;
        return "done";
      },
      isTerminal: () => true,
      timeoutMs: 9_000,
      now: () => 0,
    });
    expect(seen).toBe(9_000);
  });

  it("rethrows non-transient errors", async () => {
    await expect(
      pollUntil({
        fetchStatus: async () => {
          throw new HttpError(401, "nope", "https://x");
        },
        isTerminal: () => true,
        timeoutMs: 1000,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("times out with a resume hint", async () => {
    let t = 0;
    await expect(
      pollUntil({
        fetchStatus: async () => "processing",
        isTerminal: () => false,
        timeoutMs: 10_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        resumeHint: "Resume with: multix x status abc",
      }),
    ).rejects.toThrow(PollTimeoutError);
  });

  it("mentions the last transient error on timeout", async () => {
    let t = 0;
    await expect(
      pollUntil({
        fetchStatus: async () => {
          throw new HttpError(503, "upstream down", "https://x");
        },
        isTerminal: () => false,
        timeoutMs: 5_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
    ).rejects.toThrow(/Last error: HTTP 503/);
  });

  it("classifies transient errors", () => {
    expect(isTransientHttpError(new HttpError(0, "net", "u"))).toBe(true);
    expect(isTransientHttpError(new HttpError(429, "", "u"))).toBe(true);
    expect(isTransientHttpError(new HttpError(502, "", "u"))).toBe(true);
    expect(isTransientHttpError(new HttpError(408, "", "u"))).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientHttpError(new HttpError(status, "", "u"))).toBe(false);
    }
    expect(isTransientHttpError(new ConfigError("GEMINI_API_KEY is not set"))).toBe(false);
    expect(isTransientHttpError(new ValidationError("bad flag"))).toBe(false);
    expect(isTransientHttpError(new Error("x"))).toBe(false);
  });
});

describe("parseJsonInput", () => {
  it("parses inline JSON objects", () => {
    expect(parseJsonInput('{"prompt":"hi"}')).toEqual({ prompt: "hi" });
  });

  it("reads @file payloads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-json-"));
    const file = path.join(dir, "in.json");
    fs.writeFileSync(file, '{"n":2}');
    try {
      expect(parseJsonInput(`@${file}`)).toEqual({ n: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects arrays, invalid JSON and missing files", () => {
    expect(() => parseJsonInput("[1]")).toThrow(ValidationError);
    expect(() => parseJsonInput("{nope")).toThrow(ValidationError);
    expect(() => parseJsonInput("@/definitely/missing.json")).toThrow(ValidationError);
  });
});
