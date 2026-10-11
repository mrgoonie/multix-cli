import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import {
  FILES_API_MAX_BYTES,
  uploadFile,
  uploadTimeoutMs,
} from "../../../../src/providers/gemini/client.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";

const GOOGLE = "https://generativelanguage.googleapis.com";
const SESSION_PATH = "/upload/v1beta/files?upload_id=session-secret";

const FILE_REF = {
  name: "files/abc",
  uri: `${GOOGLE}/v1beta/files/abc`,
  state: "ACTIVE",
  mimeType: "application/pdf",
};

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  head: string;
}

/**
 * Local Files API stand-in: answers the resumable `start` request with an
 * upload URL, then drains the `upload, finalize` body without keeping it.
 */
async function startUploadServer(): Promise<{
  port: number;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const r: Received = { url: req.url ?? "", headers: req.headers, bytes: 0, head: "" };
    req.on("data", (chunk: Buffer) => {
      r.bytes += chunk.length;
      if (r.head.length < 512) r.head += chunk.subarray(0, 512).toString("latin1");
    });
    req.on("end", () => {
      received.push(r);
      if (req.headers["x-goog-upload-command"] === "start") {
        const { port } = server.address() as AddressInfo;
        res.writeHead(200, { "x-goog-upload-url": `http://127.0.0.1:${port}${SESSION_PATH}` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ file: FILE_REF }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

describe("gemini uploadFile (resumable, streamed)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-upload-"));
    _resetGeminiKeyCooldowns();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("streams the file through real fetch without allocating a file-sized buffer", async () => {
    const file = path.join(dir, "doc.pdf");
    const size = 256 * 1024 * 1024;
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, size); // zero-filled without allocating it in the test

    const readSync = vi.spyOn(fs, "readFileSync");
    const readAsync = vi.spyOn(fs.promises, "readFile");

    const realFetch = globalThis.fetch;
    const inits: RequestInit[] = [];
    let server: Awaited<ReturnType<typeof startUploadServer>> | undefined;
    let sampler: ReturnType<typeof setInterval> | undefined;
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    try {
      server = await startUploadServer();
      const local = `http://127.0.0.1:${server.port}`;
      vi.stubGlobal("fetch", (url: string, i: RequestInit) => {
        inits.push(i);
        return realFetch(url.replace(GOOGLE, local), i);
      });
      sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      }, 1);

      const ref = await uploadFile(file, { apiKey: "test-key-0000" });
      expect(ref).toEqual(FILE_REF);
    } finally {
      clearInterval(sampler);
      await server?.close();
    }
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);

    expect(readSync).not.toHaveBeenCalled();
    expect(readAsync).not.toHaveBeenCalled();
    // A buffered upload holds at least one full copy of the file. Short-lived chunk garbage
    // plateaus well below half of it, because V8 collects every ~64 MB of external memory.
    expect(peak - before).toBeLessThan(size / 2);
    // Following redirects makes fetch tee the body, and the copy retains every chunk.
    expect(inits.map((i) => i.redirect)).toEqual(["error", "error"]);

    const received = server?.received ?? [];
    expect(received).toHaveLength(2);
    const [start, upload] = received;
    if (!start || !upload) return;

    // Start: small JSON metadata, the real size and type announced in headers.
    expect(start.url).toBe("/upload/v1beta/files");
    expect(start.headers["x-goog-api-key"]).toBe("test-key-0000");
    expect(start.headers["x-goog-upload-protocol"]).toBe("resumable");
    expect(start.headers["x-goog-upload-command"]).toBe("start");
    expect(start.headers["x-goog-upload-header-content-length"]).toBe(String(size));
    expect(start.headers["x-goog-upload-header-content-type"]).toBe("application/pdf");
    expect(JSON.parse(start.head)).toEqual({ file: { display_name: "doc.pdf" } });

    // Upload: the bare file bytes to the session URL, Content-Length from the Blob.
    expect(upload.url).toBe(SESSION_PATH);
    expect(upload.headers["x-goog-upload-command"]).toBe("upload, finalize");
    expect(upload.headers["x-goog-upload-offset"]).toBe("0");
    expect(upload.headers["x-goog-api-key"]).toBeUndefined();
    expect(upload.bytes).toBe(size);
    expect(upload.headers["content-length"]).toBe(String(size));
  }, 30_000);

  it("rejects files above the 2 GB Files API limit before any request", async () => {
    const file = path.join(dir, "huge.mp4");
    fs.writeFileSync(file, "x");
    const realStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realStat(p, o) as fs.Stats;
      return p === file ? Object.assign(st, { size: FILES_API_MAX_BYTES + 1 }) : st;
    }) as typeof fs.statSync);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(FILES_API_MAX_BYTES).toBe(2_000_000_000);
    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/huge\.mp4 .*limit 2 GB/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rotates to the next key when the upload is rate-limited", async () => {
    vi.stubEnv("GEMINI_API_KEY", "key-a");
    vi.stubEnv("GEMINI_API_KEY_2", "key-b");
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");

    const keys: Array<string | undefined> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("upload_id=")) {
        return new Response(JSON.stringify({ file: FILE_REF }), { status: 200 });
      }
      const key = headerOf(init, "x-goog-api-key");
      keys.push(key);
      if (key === "key-a") return new Response("quota exceeded", { status: 429 });
      return new Response(null, {
        status: 200,
        headers: { "x-goog-upload-url": `${GOOGLE}${SESSION_PATH}` },
      });
    });

    const ref = await uploadFile(file);
    expect(ref).toEqual(FILE_REF);
    expect(keys).toEqual(["key-a", "key-b"]);
  });

  it("throws HttpError with the status and without the session URL when sending fails", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("upload_id=")
        ? new Response("backend error", { status: 503 })
        : new Response(null, {
            status: 200,
            headers: { "x-goog-upload-url": `${GOOGLE}${SESSION_PATH}` },
          }),
    );

    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).rawUrl).not.toContain("upload_id");
    expect(String((err as Error).message)).not.toContain("session-secret");
  });

  it("fails clearly when the start response has no upload URL", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));

    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/no upload URL/);
  });

  it("wraps transport failures in ProviderError and keeps the cause", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    const failure = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    vi.stubGlobal("fetch", async () => {
      throw failure;
    });

    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(HttpError); // must not trigger key rotation
    expect((err as Error).message).toBe("File upload failed: fetch failed: unexpected redirect");
    expect((err as Error).cause).toBe(failure);
  });
});

describe("uploadTimeoutMs", () => {
  it("keeps the base timeout for small files", () => {
    expect(uploadTimeoutMs(10 * 1024 * 1024, 300_000)).toBe(300_000);
  });

  it("allows 1 MB/s plus 60 s for large files", () => {
    expect(uploadTimeoutMs(FILES_API_MAX_BYTES, 300_000)).toBe(60_000 + 2_000_000);
    expect(uploadTimeoutMs(500_000_000)).toBe(560_000);
  });
});
