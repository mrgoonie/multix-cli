import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PollTimeoutError,
  isRetryableServerStatus,
  isTransientHttpError,
  pollUntil,
} from "../../../src/core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ResponseTooLargeError,
  ValidationError,
} from "../../../src/core/errors.js";
import { isNetworkFetchFailure, toFetchError } from "../../../src/core/fetch-error.js";
import { fetchJson, parseRetryAfter } from "../../../src/core/fetch-json.js";
import { parseJsonInput } from "../../../src/core/json-input.js";
import { redactUrl, redactUrlsInText } from "../../../src/core/redact.js";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../helpers/import-graph.js";

const WORKER_SAFE_MODULES = [
  "redact.ts",
  "fetch-json.ts",
  "fetch-error.ts",
  "redirect-fetch.ts",
  "async-poll.ts",
  "errors.ts",
  "response-read.ts",
];

describe("worker-safe core modules", () => {
  it.each(WORKER_SAFE_MODULES)(
    "%s reaches no Node built-ins, dotenv or process through its imports",
    (file) => {
      expect(formatNodeOnlyUses(findNodeOnlyUses(`src/core/${file}`))).toEqual([]);
    },
  );
});

describe("findNodeOnlyUses", () => {
  it("follows value re-exports and require, and skips type-only imports and comments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-graph-"));
    const write = (name: string, src: string) => fs.writeFileSync(path.join(dir, name), src);
    write(
      "entry.ts",
      [
        'export { a } from "./a.js";',
        'export type { T } from "./typed.js";',
        'import type { U } from "node:fs";',
        "// process.env and node:os in a comment do not count",
        'const os = require("os");',
      ].join("\n"),
    );
    write("a.ts", 'export * from "node:stream";\nexport const a = globalThis.process.env;');
    write("typed.ts", 'import fs from "node:fs";\nexport type T = string;');
    try {
      const found = findNodeOnlyUses(path.join(dir, "entry.ts")).map(
        (u) => `${u.chain.map((f) => path.basename(f)).join(" -> ")}: ${u.problem}`,
      );
      expect(found.sort()).toEqual(
        [
          'entry.ts: imports Node built-in "os"',
          'entry.ts -> a.ts: imports "node:stream"',
          "entry.ts -> a.ts: uses process.",
        ].sort(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("redactUrlsInText", () => {
  it("redacts the query of every URL in free text and keeps the rest", () => {
    expect(
      redactUrlsInText(
        "failed to download https://cdn.example.com/a.wav?sig=SECRET1 (see https://openrouter.ai/docs)",
      ),
    ).toBe(
      "failed to download https://cdn.example.com/a.wav?[redacted] (see https://openrouter.ai/docs)",
    );
    // Opaque-origin schemes collapse whole, as with redactUrl.
    expect(redactUrlsInText("gs://bucket/a.mp3?token=SECRET2 failed")).toBe("gs:[redacted] failed");
  });

  it("catches a query tail after a URL with a space, and is idempotent", () => {
    const once = redactUrlsInText("bad url https://x.test/my file.wav?sig=SECRET3");
    expect(once).toBe("bad url https://x.test/my file.wav?[redacted]");
    expect(redactUrlsInText(once)).toBe(once);
  });

  it("redacts the whole query when a raw JSON body escapes & or /", () => {
    const goStyle = String.raw`{"error":"cannot fetch https://s3.example.com/a.wav?X-Amz-Algorithm=A\u0026X-Amz-Signature=SECRET5"}`;
    const phpStyle = String.raw`{"error":"cannot fetch https:\/\/s3.example.com\/a.wav?a=1\/2\u0026sig=SECRET6 now"}`;
    for (const body of [goStyle, phpStyle]) {
      const out = redactUrlsInText(body);
      expect(out).not.toMatch(/SECRET/);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(redactUrlsInText(out)).toBe(out);
    }
    expect(redactUrlsInText(phpStyle)).toContain("?[redacted] now");
  });

  it("leaves an already redacted message unchanged", () => {
    const message = new HttpError(400, "bad input", "https://x.test/a?key=SECRET7").message;
    expect(message).toBe("HTTP 400 from https://x.test/a?[redacted]: bad input");
    expect(redactUrlsInText(message)).toBe(message);
  });

  it("keeps a JSON error body parseable", () => {
    const body = JSON.stringify({
      error: { message: 'cannot fetch "https://x.test/a.mp3?sig=SECRET4"' },
    });
    const out = redactUrlsInText(body);
    expect(out).not.toContain("SECRET4");
    expect(JSON.parse(out).error.message).toBe('cannot fetch "https://x.test/a.mp3?[redacted]"');
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

  it("redacts URL queries a provider echoes in the response snippet", () => {
    const e = new HttpError(
      400,
      "Failed to download https://cdn.example.com/a.wav?X-Amz-Signature=SECRETSIG",
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
    expect(e.snippet).toBe("Failed to download https://cdn.example.com/a.wav?[redacted]");
    expect(e.message).not.toContain("SECRETSIG");
    expect(JSON.stringify(e)).not.toContain("SECRETSIG");
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

  it("refuses a body whose Content-Length is over maxBytes without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const error = await fetchJson({
      url: "https://api.test/x?key=secret",
      maxBytes: 10,
      fetch: async () => new Response(body, { status: 200, headers: { "content-length": "11" } }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).not.toContain("secret");
    expect(cancelled).toBe(true);
  });

  it("stops reading once a body without Content-Length passes maxBytes", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchJson({
        url: "https://api.test/x",
        maxBytes: 10,
        fetch: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("reads a body within maxBytes, keeping characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: "Xin chào – ok" }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    await expect(
      fetchJson({
        url: "https://api.test/x",
        maxBytes: bytes.length,
        fetch: async () => new Response(body, { status: 200 }),
      }),
    ).resolves.toEqual({ text: "Xin chào – ok" });
  });

  it("gives up on a request whose response never starts after responseTimeoutMs", async () => {
    const started = Date.now();
    const error = await fetchJson({
      url: "https://api.test/x",
      timeoutMs: 10_000,
      responseTimeoutMs: 30,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("drops a body that stops arriving for idleTimeoutMs as a retryable network failure", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await fetchJson({
      url: "https://api.test/x",
      timeoutMs: 10_000,
      idleTimeoutMs: 30,
      fetch: async () => new Response(body, { status: 200 }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 0 });
    expect(cancelled).toBe(true);
  });

  it("reports a body cut off by the overall timeout as a retryable network failure", async () => {
    const error = await fetchJson({
      url: "https://api.test/x",
      timeoutMs: 50,
      responseTimeoutMs: 10,
      maxBytes: 1_000,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
          }),
          { status: 200 },
        ),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 0 });
  });

  it("lets the body take the rest of timeoutMs once the response has started", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(new TextEncoder().encode('{"done":true}'));
        controller.close();
      },
    });
    await expect(
      fetchJson({
        url: "https://api.test/x",
        timeoutMs: 5_000,
        responseTimeoutMs: 20,
        maxBytes: 1_000,
        fetch: async () => new Response(body, { status: 200 }),
      }),
    ).resolves.toEqual({ done: true });
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
    expect(isTransientHttpError(new HttpError(500, "", "u"))).toBe(true);
    expect(isTransientHttpError(new HttpError(504, "", "u"))).toBe(true);
    for (const status of [400, 401, 403, 404, 422, 501, 505]) {
      expect(isTransientHttpError(new HttpError(status, "", "u"))).toBe(false);
    }
    expect(isTransientHttpError(new ConfigError("GEMINI_API_KEY is not set"))).toBe(false);
    expect(isTransientHttpError(new ValidationError("bad flag"))).toBe(false);
    expect(isTransientHttpError(new ProviderError("File upload failed", "gemini"))).toBe(false);
    expect(isTransientHttpError(new Error("x"))).toBe(false);
  });

  it("shares one server-status rule across retry policies", () => {
    for (const status of [0, 500, 502, 503, 504])
      expect(isRetryableServerStatus(status)).toBe(true);
    for (const status of [400, 408, 429, 501, 505]) {
      expect(isRetryableServerStatus(status)).toBe(false);
    }
  });

  it("does not poll again after a 501", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new HttpError(501, "not implemented", "https://api.example.com/jobs/1");
    });
    await expect(
      pollUntil({
        fetchStatus,
        isTerminal: () => true,
        timeoutMs: 60_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/HTTP 501/);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe("toFetchError", () => {
  const url = "https://api.example.com/v1/x?key=SECRET";
  const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

  it.each([
    ["ECONNRESET cause", new TypeError("fetch failed", { cause: withCode("read", "ECONNRESET") })],
    [
      "undici socket cause",
      new TypeError("fetch failed", { cause: withCode("x", "UND_ERR_SOCKET") }),
    ],
    [
      "nested DNS cause",
      new TypeError("fetch failed", {
        cause: new Error("wrapped", { cause: withCode("getaddrinfo", "ENOTFOUND") }),
      }),
    ],
    [
      "AggregateError cause",
      new TypeError("fetch failed", {
        cause: new AggregateError([withCode("connect", "ECONNREFUSED")], "all failed"),
      }),
    ],
    [
      "connect-attempt timeout cause",
      new TypeError("fetch failed", {
        cause: withCode("connect timed out", "ERR_SOCKET_CONNECTION_TIMEOUT"),
      }),
    ],
    ["ENETDOWN cause", new TypeError("fetch failed", { cause: withCode("down", "ENETDOWN") })],
    ["EPROTO cause", new TypeError("fetch failed", { cause: withCode("handshake", "EPROTO") })],
    ["TimeoutError", new DOMException("timed out", "TimeoutError")],
    ["AbortError", new DOMException("aborted", "AbortError")],
    // Cloudflare Workers reject without Node error codes.
    ["codeless Worker Error", new Error("Network connection lost.")],
    ["codeless Worker TypeError", new TypeError("Network connection lost.")],
    ["codeless cause", new TypeError("fetch failed", { cause: new Error("bad port") })],
    ["non-Error value", "boom"],
  ])("maps a %s to a transient HttpError(0) keeping the cause", (_label, failure) => {
    expect(isNetworkFetchFailure(failure)).toBe(true);
    const err = toFetchError(failure, url);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect(isTransientHttpError(err)).toBe(true);
    expect(err.cause).toBe(failure);
    expect(err.message).not.toContain("SECRET");
  });

  it("maps an invalid header value to a ConfigError without echoing it", async () => {
    let failure: unknown;
    try {
      new Headers({ "x-api-key": "abc“secret-value" });
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(TypeError);
    const err = toFetchError(failure, url);
    expect(err).toBeInstanceOf(ConfigError);
    expect(isTransientHttpError(err)).toBe(false);
    expect(err.message).toMatch(/Invalid HTTP header value/);
    expect(err.message).not.toContain("secret-value");
    expect(err.message).not.toContain("SECRET");
    expect(err.cause).toBe(failure);
  });

  it("maps an invalid URL to a ConfigError with the query string redacted", async () => {
    const failure = await fetch("ht tp://bad url?key=SECRET").catch((e: unknown) => e);
    const err = toFetchError(failure, "ht tp://bad url?key=SECRET");
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toBe("Invalid request URL: ht tp://bad url?[redacted]");
    expect(err.cause).toBe(failure);
  });

  it.each([
    ["ERR_INVALID_URL", withCode("Invalid URL", "ERR_INVALID_URL")],
    [
      "ERR_INVALID_CHAR",
      withCode('Invalid character in header content ["x-api-key"]', "ERR_INVALID_CHAR"),
    ],
    [
      "ERR_INVALID_HTTP_TOKEN",
      withCode("Header name must be a valid HTTP token", "ERR_INVALID_HTTP_TOKEN"),
    ],
    ["legal header value", new TypeError("'abc\nsecret' is not a legal HTTP header value")],
  ])("maps %s to a non-transient ConfigError", (_label, failure) => {
    expect(isNetworkFetchFailure(failure)).toBe(false);
    const err = toFetchError(failure, url);
    expect(err).toBeInstanceOf(ConfigError);
    expect(isTransientHttpError(err)).toBe(false);
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("SECRET");
  });

  it.each([
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
    ["UND_ERR_INVALID_ARG", "invalid upgrade header"],
    ["UND_ERR_NOT_SUPPORTED", "not supported"],
  ])("maps a %s cause to a non-transient ProviderError naming it", (code, message) => {
    const failure = new TypeError("fetch failed", { cause: withCode(message, code) });
    expect(isNetworkFetchFailure(failure)).toBe(false);
    const err = toFetchError(failure, url, { provider: "replicate" });
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).provider).toBe("replicate");
    expect(isTransientHttpError(err)).toBe(false);
    expect(err.message).toBe(
      `Request to https://api.example.com/v1/x?[redacted] failed: fetch failed: ${message}`,
    );
    expect(err.cause).toBe(failure);
  });

  it.each([
    "duplex option is required",
    "Request with GET/HEAD method cannot have body",
    "unexpected redirect",
  ])("does not retry a request fetch refuses to send (%s)", (message) => {
    const failure = new TypeError("fetch failed", { cause: new TypeError(message) });
    expect(toFetchError(failure, url)).toBeInstanceOf(ProviderError);
  });

  it("applies a prefix and target, and scrubs URLs containing spaces", () => {
    const failure = new TypeError("fetch failed", {
      cause: withCode("bad cert for https://h.test/a b?token=SECRET&x=1", "CERT_HAS_EXPIRED"),
    });
    const err = toFetchError(failure, url, {
      prefix: "File upload failed: ",
      target: "the upload session URL",
    });
    expect(err.message).toBe(
      "File upload failed: Request to the upload session URL failed: fetch failed: bad cert for https://h.test/a b?[redacted]",
    );
  });

  it("makes fetchJson fail once on an invalid header instead of reporting a network error", async () => {
    const doFetch = vi.fn(async (_input: string, init?: RequestInit) => {
      new Headers(init?.headers);
      return new Response("{}");
    });
    await expect(
      fetchJson({ url, headers: { "x-api-key": "bad’key" }, fetch: doFetch }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(doFetch).toHaveBeenCalledTimes(1);
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
