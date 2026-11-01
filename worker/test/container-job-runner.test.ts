/**
 * The container's job runner and job server (plain Node .mjs), run in vitest
 * with a fake `multix` binary and mocked fetch: no network, no provider.
 * Loaded by file URL so the Worker typecheck never sees Node types.
 */

import { describe, expect, it } from "vitest";
import { isNonPublicIpv6 } from "../src/events/callback-guard.js";

// biome-ignore lint/suspicious/noExplicitAny: untyped .mjs modules
type Any = any;
const testFileUrl = (import.meta as unknown as { url: string }).url;
const local = (rel: string) => decodeURIComponent(new URL(rel, testFileUrl).pathname);
const load = (rel: string): Promise<Any> => import(/* @vite-ignore */ local(rel));

const FAKE_BIN = local("./fixtures/fake-multix.mjs");

// Node built-ins, loaded untyped like the .mjs modules above.
const nodeModule = (name: string): Promise<Any> => import(/* @vite-ignore */ name);
const { execFileSync } = await nodeModule("node:child_process");
const { createServer: createHttpsServer } = await nodeModule("node:https");
const { mkdtempSync, readFileSync, rmSync } = await nodeModule("node:fs");
const { tmpdir } = await nodeModule("node:os");
const { join } = await nodeModule("node:path");

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A throwaway self-signed certificate for localhost, made with openssl. */
function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "multix-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
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
    expect(result.note).toContain("R2 or S3-compatible bucket in /dashboard");
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

  it.each([
    [`team/out/0123456789abcdef/${JOB_ID}`, true],
    [`0123456789abcdef/${JOB_ID}`, false],
    [`../0123456789abcdef/${JOB_ID}`, false],
    [`a/./0123456789abcdef/${JOB_ID}`, false],
    [`a b/0123456789abcdef/${JOB_ID}`, false],
    ["multix/0123456789abcdef/not-a-job", false],
  ])("checks the upload key prefix %s", async (keyPrefix, valid) => {
    const { validateSpec } = await load("../container/job-runner.mjs");
    const check = () => validateSpec(spec({ upload: { r2: R2, keyPrefix } }));
    if (valid) expect(check).not.toThrow();
    else expect(check).toThrow("Invalid job");
  });

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

  it("kills a CLI that ignores SIGTERM after the grace period, on timeout and on cancel", async () => {
    const { runJob } = await load("../container/job-runner.mjs");
    const { fetch, get } = mockFetch();
    const argv = ["x", "--ignore-term", "--sleep"];
    const started = Date.now();
    const timedOut = await runJob(spec({ argv, inputs: [], timeoutMs: 400 }), {
      bin: FAKE_BIN,
      fetch,
      get,
      killGraceMs: 300,
    });
    expect(timedOut.status).toBe("timed_out");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const canceled = await runJob(spec({ argv, inputs: [] }), {
      bin: FAKE_BIN,
      fetch,
      get,
      signal: controller.signal,
      killGraceMs: 300,
    });
    expect(canceled.status).toBe("canceled");
    // Without SIGKILL each run would wait for the 30 s sleep.
    expect(Date.now() - started).toBeLessThan(10_000);

    // An output overflow is answered with SIGTERM too; SIGKILL follows the grace, not the CLI timeout.
    const floodStart = Date.now();
    const flooded = await runJob(
      spec({ argv: ["x", "--ignore-term", "--flood"], inputs: [], timeoutMs: 20_000 }),
      { bin: FAKE_BIN, fetch, get, killGraceMs: 300 },
    );
    expect(flooded.status).toBe("failed");
    expect(Date.now() - floodStart).toBeLessThan(4_000);
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

describe("container S3-compatible uploads", () => {
  const S3 = {
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    accessKeyId: "s3-access-key-id-123456",
    secretAccessKey: "s3-secret-access-key-value-123456",
    bucket: "media",
  };
  const recorder = () => {
    const calls: { url: string; method: string; auth: string | null }[] = [];
    const fetch = async (input: string, init: RequestInit) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response("", { status: 200 });
    };
    return { fetch, calls };
  };

  it("PUTs path-style to the endpoint, signed for its region, with presigned links for the chosen lifetime", async () => {
    const { createR2Uploader } = await load("../container/r2-upload.mjs");
    const { fetch, calls } = recorder();
    const uploader = createR2Uploader({ ...S3, linkExpirySeconds: 3600 }, { fetch });
    const url = new URL(await uploader.put("multix/a/b c.png", "x", "image/png"));
    expect(calls[0]?.url).toBe("https://s3.eu-central-1.amazonaws.com/media/multix/a/b%20c.png");
    expect(calls[0]?.auth).toMatch(/\/eu-central-1\/s3\/aws4_request, /);
    expect(url.origin + url.pathname).toBe(
      "https://s3.eu-central-1.amazonaws.com/media/multix/a/b%20c.png",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/\/eu-central-1\/s3\/aws4_request$/);
    expect(url.toString()).not.toContain(S3.secretAccessKey);
  });

  it("uses virtual-hosted URLs and keeps R2 on its fixed host and region", async () => {
    const { createR2Uploader } = await load("../container/r2-upload.mjs");
    const s3 = recorder();
    await createR2Uploader({ ...S3, addressing: "virtual" }, { fetch: s3.fetch }).put(
      "k.txt",
      "x",
      "text/plain",
    );
    expect(s3.calls[0]?.url).toBe("https://media.s3.eu-central-1.amazonaws.com/k.txt");
    const r2 = recorder();
    const link = new URL(
      await createR2Uploader(R2, { fetch: r2.fetch }).put("k.txt", "x", "text/plain"),
    );
    expect(r2.calls[0]?.url).toBe(`https://${R2.accountId}.r2.cloudflarestorage.com/media/k.txt`);
    expect(r2.calls[0]?.auth).toMatch(/\/auto\/s3\/aws4_request, /);
    expect(link.searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it.each([
    "https://10.0.0.1",
    "https://[fd00::1]",
    "https://localhost",
    "https://minio.svc.cluster.local",
    "https://metadata.google.internal",
    "https://s3.example.com:9000",
    "https://s3.example.com/path",
    "http://s3.example.com",
  ])("refuses the endpoint %s", async (endpoint) => {
    const { createR2Uploader } = await load("../container/r2-upload.mjs");
    expect(() => createR2Uploader({ ...S3, endpoint })).toThrow("Invalid storage endpoint");
  });

  it("refuses both an account id and an endpoint, bad regions and dotted virtual-hosted buckets", async () => {
    const { createR2Uploader } = await load("../container/r2-upload.mjs");
    expect(() => createR2Uploader({ ...S3, accountId: R2.accountId })).toThrow();
    expect(() => createR2Uploader({ ...S3, region: "EU West" })).toThrow("Invalid storage region");
    expect(() => createR2Uploader({ ...S3, addressing: "virtual", bucket: "a.b.c" })).toThrow(
      "Invalid bucket name",
    );
    expect(() => createR2Uploader({ ...S3, bucket: "a.b.c" })).not.toThrow();
  });

  it("uploads to a custom endpoint only over a connection checked to be public", async () => {
    const { createPublicLookup, publicHttpsFetch } = await load("../container/job-network.mjs");
    for (const address of ["10.0.0.5", "169.254.169.254", "127.0.0.1"]) {
      const lookup = createPublicLookup(
        (_host: string, _opts: unknown, cb: (e: unknown, a: unknown) => void) =>
          cb(null, [{ address, family: 4 }]),
      );
      await expect(
        publicHttpsFetch("https://rebind.example.com/media/k.txt", {
          method: "PUT",
          body: new Blob(["data"]).stream(),
          lookup,
        }),
      ).rejects.toMatchObject({ code: "EBLOCKEDADDRESS" });
    }
    await expect(publicHttpsFetch("http://s3.example.com/x")).rejects.toThrow("Only https");
  });

  it.skipIf(!hasOpenssl)("streams a PUT with its length and maps the response back", async () => {
    const { publicHttpsFetch } = await load("../container/job-network.mjs");
    const { key, cert } = selfSignedCert();
    const seen: { method?: string; host?: string; length?: string; bytes: number } = { bytes: 0 };
    const server = createHttpsServer({ key, cert }, (req: Any, res: Any) => {
      seen.method = req.method;
      seen.host = req.headers.host;
      seen.length = req.headers["content-length"];
      req.on("data", (chunk: Uint8Array) => {
        seen.bytes += chunk.length;
      });
      req.on("end", () => {
        if (req.url === "/denied") {
          res.writeHead(403, { "content-type": "application/xml" });
          res.end("<Error><Code>AccessDenied</Code></Error>");
          return;
        }
        res.writeHead(200, { etag: '"abc"' });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    // Test-only lookup: the real one refuses loopback, which the tests above cover.
    const lookup = (_h: string, o: Any, cb: Any) => {
      const done = typeof o === "function" ? o : cb;
      if (o?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    };
    try {
      const payload = new Uint8Array(3 * 1024 * 1024).fill(7);
      const ok = await publicHttpsFetch(`https://localhost:${port}/media/k.bin`, {
        method: "PUT",
        headers: { "content-length": String(payload.length) },
        body: new Blob([payload]).stream(),
        lookup,
        ca: cert,
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("etag")).toBe('"abc"');
      expect(seen).toEqual({
        method: "PUT",
        host: `localhost:${port}`,
        length: String(payload.length),
        bytes: payload.length,
      });
      const denied = await publicHttpsFetch(`https://localhost:${port}/denied`, {
        method: "PUT",
        headers: { "content-length": "4" },
        body: "data",
        lookup,
        ca: cert,
      });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toContain("AccessDenied");
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        publicHttpsFetch(`https://localhost:${port}/x`, {
          signal: aborted.signal,
          lookup,
          ca: cert,
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it("refuses at connect time every address the save-time check refuses", async () => {
    const { isPublicAddress } = await load("../container/job-network.mjs");
    const addresses = [
      "::ffff:0:a00:1",
      "64:ff9b:1:a00:1:0:808:808",
      "64:ff9b::808:808",
      "4000::1",
      "3fff::1",
      "2001::1",
      "2001:20::1",
      "2001:2::1",
      "2002:808:808::1",
      "fc00::1",
      "fe80::1",
      "::1",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "2606:4700:4700::1111",
      "2a00:1450:4001::1",
    ];
    for (const ip of addresses) {
      expect(isPublicAddress(ip), ip).toBe(!isNonPublicIpv6(ip));
    }
  });

  it("reads at most 64 KiB of an error body", async () => {
    const { createR2Uploader } = await load("../container/r2-upload.mjs");
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 16 * 1024;
        if (pulled > 4 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(
          new TextEncoder().encode("<Code>SlowDown</Code>".padEnd(16 * 1024, " ")),
        );
      },
    });
    const uploader = createR2Uploader(
      {
        endpoint: "https://s3.example.com",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret",
        bucket: "media",
      },
      { fetch: async () => new Response(huge, { status: 503 }) },
    );
    await expect(
      uploader.put("multix/x/out.txt", new Blob(["data"]).stream(), "text/plain", {
        contentLength: 4,
      }),
    ).rejects.toThrow("Output upload failed: HTTP 503 SlowDown");
    expect(pulled).toBeLessThanOrEqual(128 * 1024);
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
