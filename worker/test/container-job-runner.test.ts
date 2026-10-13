/**
 * The container's job runner and job server (plain Node .mjs), run in vitest
 * with a fake `multix` binary and mocked fetch: no network, no provider.
 * Loaded by file URL so the Worker typecheck never sees Node types.
 */

import { describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: untyped .mjs modules
type Any = any;
const testFileUrl = (import.meta as unknown as { url: string }).url;
const local = (rel: string) => decodeURIComponent(new URL(rel, testFileUrl).pathname);
const load = (rel: string): Promise<Any> => import(/* @vite-ignore */ local(rel));

const FAKE_BIN = local("./fixtures/fake-multix.mjs");
const KEY = "AIza-gemini-secret-value-1234";
const R2 = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "r2-access-key-id-123456",
  secretAccessKey: "r2-secret-access-key-value-123456",
  bucket: "media",
};
const JOB_ID = "11111111-2222-4333-8444-555555555555";

function spec(overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    argv: ["media", "optimize", "--input=in/0-photo.png", "--output=out/x.png"],
    env: { GEMINI_API_KEY: KEY },
    inputs: [{ url: "https://cdn.example.com/photo.png", path: "in/0-photo.png" }],
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Mocked network: `fetch` for R2 uploads, and the same function as `get` for input downloads. */
function mockFetch() {
  const calls: { url: string; method: string; bytes: number; length: string | null }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const bytes = init?.body ? (await new Response(init.body).arrayBuffer()).byteLength : 0;
    const length = new Headers(init?.headers).get("content-length");
    calls.push({ url, method: init?.method ?? "GET", bytes, length });
    if (url === "https://cdn.example.com/photo.png") return new Response("PIXELS");
    if (url === "https://cdn.example.com/redirect") {
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x" } });
    }
    const hop = /^https:\/\/cdn\.example\.com\/hop(\d+)$/.exec(url);
    if (hop) {
      const next = Number(hop[1]) + 1;
      const location = next > 5 ? "/photo.png" : `/hop${next}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    if (url === "https://rebind.example.com/x.png") {
      const { BlockedAddressError } = await load("../container/job-network.mjs");
      throw new BlockedAddressError();
    }
    if (url.startsWith("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/")) {
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, get: fetch, calls };
}

describe("container job runner", () => {
  it("downloads inputs, runs the CLI with a clean env, and reports outputs (no R2)", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const result = await runJob(spec(), { bin: FAKE_BIN, fetch, get });
    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen.argv).toEqual(spec().argv);
    expect(seen.input).toBe("PIXELS");
    // cwd may be the realpath of HOME (macOS /var -> /private/var).
    expect(seen.cwd.endsWith(seen.home)).toBe(true);
    expect(seen.home).toMatch(/multix-job-/);
    expect(seen.out).toBe(`${seen.home}/out`);
    expect(seen.disableHomeEnv).toBe("1");
    expect(seen.envNames).toEqual(
      expect.arrayContaining(["GEMINI_API_KEY", "HOME", "MULTIX_OUTPUT_DIR", "NO_COLOR", "PATH"]),
    );
    expect(seen.envNames).not.toContain("NODE_OPTIONS");
    expect(result.stderrTail).toBe("using key [redacted]\n");
    expect(result.outputs).toEqual([
      // out/nested/result.txt sorts first; the second file with that base name gets a prefix.
      { name: "result.txt", url: null, bytes: 5 },
      { name: "1-result.txt", url: null, bytes: 5 },
    ]);
    expect(result.note).toContain("configure R2 in /dashboard");
    const fs: Any = await import(/* @vite-ignore */ ["node", "fs"].join(":"));
    expect(fs.existsSync(seen.home)).toBe(false);
  }, 30_000);

  it("uploads every output under the job prefix with safe names", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get, calls } = mockFetch();
    const keyPrefix = `multix/0123456789abcdef/${JOB_ID}`;
    const result = await runJob(
      spec({ upload: { r2: { ...R2, publicBaseUrl: "https://media.example.com" }, keyPrefix } }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(result.status).toBe("succeeded");
    expect(result.outputs.map((o: { url: string }) => o.url)).toEqual([
      `https://media.example.com/${keyPrefix}/result.txt`,
      `https://media.example.com/${keyPrefix}/1-result.txt`,
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => new URL(c.url).pathname)).toEqual([
      `/media/${keyPrefix}/result.txt`,
      `/media/${keyPrefix}/1-result.txt`,
    ]);
    // Streamed from disk with an explicit length.
    expect(puts.map((c) => [c.bytes, c.length])).toEqual([
      [5, "5"],
      [5, "5"],
    ]);
    expect(JSON.stringify(result)).not.toContain(R2.secretAccessKey);
  }, 30_000);

  it("returns 7-day presigned links without a public base URL", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const keyPrefix = `multix/0123456789abcdef/${JOB_ID}`;
    const result = await runJob(spec({ upload: { r2: R2, keyPrefix } }), {
      bin: FAKE_BIN,
      fetch,
      get,
    });
    const url = new URL(result.outputs[0].url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("reports a failing CLI, a refused input and a timeout", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const failed = await runJob(spec({ argv: ["x", "--fail"] }), { bin: FAKE_BIN, fetch, get });
    expect(failed).toMatchObject({ status: "failed", exitCode: 3 });

    const redirected = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/redirect", path: "in/0-a.png" }] }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(redirected).toMatchObject({ status: "failed", exitCode: null });
    expect(redirected.error).toBe("Input URL must be a public https URL");

    const escaped = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/photo.png", path: "in/../../x" }] }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(escaped.error).toBe("Input path is not valid");

    const slow = await runJob(spec({ argv: ["x", "--sleep"], inputs: [], timeoutMs: 500 }), {
      bin: FAKE_BIN,
      fetch,
      get,
    });
    expect(slow.status).toBe("timed_out");
  }, 30_000);

  it("follows up to 5 redirects and refuses an input that resolves to a private address", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const five = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/hop1", path: "in/0-photo.png" }] }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(five.status).toBe("succeeded");
    expect(JSON.parse(five.stdout).input).toBe("PIXELS");
    const six = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/hop0", path: "in/0-photo.png" }] }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(six.error).toBe("Input download failed: too many redirects");
    const rebound = await runJob(
      spec({ inputs: [{ url: "https://rebind.example.com/x.png", path: "in/0-x.png" }] }),
      { bin: FAKE_BIN, fetch, get },
    );
    expect(rebound.error).toBe("Input URL must resolve to a public address");
  }, 30_000);

  it("shares one deadline across downloads and the CLI", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch } = mockFetch();
    const stalled = (_url: URL, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const started = Date.now();
    const result = await runJob(spec({ timeoutMs: 400 }), { bin: FAKE_BIN, fetch, get: stalled });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ status: "timed_out", exitCode: null });
    expect(result.error).toBe("The job did not finish within its time limit");
  }, 30_000);

  it("redacts before truncating and reports an output flood as a failure", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const cut = await runJob(spec({ argv: ["x", "--key-at-cut"], inputs: [] }), {
      bin: FAKE_BIN,
      fetch,
      get,
    });
    // Cut through the marker, not through the key: no part of the key is left.
    expect(cut.stderrTail.startsWith("…[truncated]\nedacted]")).toBe(true);
    expect(cut.stderrTail).not.toContain(KEY.slice(-12));

    const flood = await runJob(spec({ argv: ["x", "--flood"], inputs: [] }), {
      bin: FAKE_BIN,
      fetch,
      get,
    });
    expect(flood.status).toBe("failed");
    expect(flood.error).toMatch(/more than 16 MB/);
  }, 30_000);

  it("validates the job body shape and the env names it may pass", async () => {
    const { validateSpec } = await load("../container/job-runner.mjs");
    expect(() => validateSpec(spec())).not.toThrow();
    expect(() => validateSpec(spec({ env: { NODE_OPTIONS: "--require x" } }))).toThrow();
    expect(() => validateSpec(spec({ env: { PATH: "/tmp" } }))).toThrow();
    expect(() => validateSpec(spec({ argv: [] }))).toThrow();
    expect(() => validateSpec(spec({ upload: { r2: R2, keyPrefix: "../other" } }))).toThrow();
    expect(() => validateSpec(null)).toThrow();
  });
});

describe("container network guard", () => {
  it("accepts only public unicast addresses", async () => {
    const { isPublicAddress } = await load("../container/job-network.mjs");
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:a00:1::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a name that resolves to any private address and pins the checked ones", async () => {
    const { createPublicLookup } = await load("../container/job-network.mjs");
    const resolver =
      (addresses: { address: string; family: number }[]) =>
      (_host: string, _opts: unknown, cb: (e: unknown, a: unknown) => void) =>
        cb(null, addresses);
    const call = (lookup: Any, options: unknown) =>
      new Promise<unknown[]>((resolve) =>
        lookup("cdn.example.com", options, (...args: unknown[]) => resolve(args)),
      );
    const mixed = createPublicLookup(
      resolver([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    const [error] = await call(mixed, { all: true });
    expect((error as Error).message).toBe("Input URL must resolve to a public address");

    const good = [{ address: "93.184.216.34", family: 4 }];
    const pinned = createPublicLookup(resolver(good));
    expect(await call(pinned, { all: true })).toEqual([null, good]);
    expect(await call(pinned, {})).toEqual([null, "93.184.216.34", 4]);
  });

  it("connects through the checked lookup, so a private answer never gets a socket", async () => {
    const { createPublicLookup, publicHttpsGet } = await load("../container/job-network.mjs");
    const lookup = createPublicLookup(
      (_host: string, _opts: unknown, cb: (e: unknown, a: unknown) => void) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    await expect(
      publicHttpsGet(new URL("https://cdn.example.com/x.png"), { lookup }),
    ).rejects.toMatchObject({ code: "EBLOCKEDADDRESS" });
  });
});

describe("container R2 key rules", () => {
  it("rejects empty and dot segments and encodes reserved characters", async () => {
    const { encodeKey, safeOutputName } = await load("../container/r2-upload.mjs");
    expect(encodeKey("multix/a/b(1)!.png")).toBe("multix/a/b%281%29%21.png");
    for (const bad of ["", "a//b", "a/./b", "a/../b", "/a", "a/"]) {
      expect(() => encodeKey(bad), bad).toThrow();
    }
    expect(safeOutputName("/tmp/job/out/nested/cat.png")).toBe("cat.png");
    expect(safeOutputName("a\u0000b\u001f.png")).toBe("ab.png");
    expect(safeOutputName("..")).toBeUndefined();
    expect(safeOutputName(".")).toBeUndefined();
    expect(safeOutputName("out/")).toBeUndefined();
  });
});

describe("container job server", () => {
  it("accepts one job, refuses a second, and reports it", async () => {
    const { createJobServer } = await load("../container/job-server.mjs");
    const server = createJobServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect(await (await fetch(`${base}/jobs/current`)).json()).toEqual({ state: "idle" });
      const bad = await fetch(`${base}/jobs`, { method: "POST", body: "{}" });
      expect(bad.status).toBe(400);
      // A job whose input cannot be fetched ends quickly without running anything.
      const job = spec({ inputs: [{ url: "https://localhost/x.png", path: "in/0-x.png" }] });
      const accepted = await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify(job) });
      expect(accepted.status).toBe(202);
      const again = await fetch(`${base}/jobs`, { method: "POST", body: JSON.stringify(job) });
      expect(again.status).toBe(409);
      let current: Any = { state: "running" };
      for (let i = 0; i < 50 && current.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        current = await (await fetch(`${base}/jobs/current`)).json();
      }
      expect(current).toMatchObject({ state: "done", result: { status: "failed" } });
      expect(JSON.stringify(current)).not.toContain(KEY);
      expect((await fetch(`${base}/jobs/current/cancel`, { method: "POST" })).status).toBe(202);
    } finally {
      server.close();
    }
  }, 30_000);
});
