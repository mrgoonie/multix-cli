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

function mockFetch() {
  const calls: { url: string; method: string; bytes: number }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body as Uint8Array | undefined;
    calls.push({ url, method: init?.method ?? "GET", bytes: body?.byteLength ?? 0 });
    if (url === "https://cdn.example.com/photo.png") return new Response("PIXELS");
    if (url === "https://cdn.example.com/redirect") {
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x" } });
    }
    if (url.startsWith("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/")) {
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

describe("container job runner", () => {
  it("downloads inputs, runs the CLI with a clean env, and reports outputs (no R2)", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch } = mockFetch();
    const result = await runJob(spec(), { bin: FAKE_BIN, fetch });
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
    const { fetch, calls } = mockFetch();
    const keyPrefix = `multix/0123456789abcdef/${JOB_ID}`;
    const result = await runJob(
      spec({ upload: { r2: { ...R2, publicBaseUrl: "https://media.example.com" }, keyPrefix } }),
      { bin: FAKE_BIN, fetch },
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
    expect(JSON.stringify(result)).not.toContain(R2.secretAccessKey);
  }, 30_000);

  it("returns 7-day presigned links without a public base URL", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch } = mockFetch();
    const keyPrefix = `multix/0123456789abcdef/${JOB_ID}`;
    const result = await runJob(spec({ upload: { r2: R2, keyPrefix } }), { bin: FAKE_BIN, fetch });
    const url = new URL(result.outputs[0].url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("reports a failing CLI, a refused input and a timeout", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch } = mockFetch();
    const failed = await runJob(spec({ argv: ["x", "--fail"] }), { bin: FAKE_BIN, fetch });
    expect(failed).toMatchObject({ status: "failed", exitCode: 3 });

    const redirected = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/redirect", path: "in/0-a.png" }] }),
      { bin: FAKE_BIN, fetch },
    );
    expect(redirected).toMatchObject({ status: "failed", exitCode: null });
    expect(redirected.error).toBe("Input URL must be a public https URL");

    const escaped = await runJob(
      spec({ inputs: [{ url: "https://cdn.example.com/photo.png", path: "in/../../x" }] }),
      { bin: FAKE_BIN, fetch },
    );
    expect(escaped.error).toBe("Input path is not valid");

    const slow = await runJob(spec({ argv: ["x", "--sleep"], inputs: [], timeoutMs: 500 }), {
      bin: FAKE_BIN,
      fetch,
    });
    expect(slow.status).toBe("timed_out");
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
