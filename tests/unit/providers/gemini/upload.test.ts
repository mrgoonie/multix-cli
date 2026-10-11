import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientHttpError } from "../../../../src/core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ValidationError,
} from "../../../../src/core/errors.js";
import {
  FILES_API_MAX_BYTES,
  uploadFile,
  uploadTimeoutMs,
} from "../../../../src/providers/gemini/client.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";
import {
  INLINE_MAX_BYTES,
  inlinePart,
  minUploadBytesPerSec,
  shouldUseFileApi,
  uploadLocalFile,
} from "../../../../src/providers/gemini/local-files.js";
import { findNodeOnlyUses, formatNodeOnlyUses } from "../../../helpers/import-graph.js";

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
      res.writeHead(200, { "content-type": "application/json", "x-goog-upload-status": "final" });
      res.end(JSON.stringify({ file: FILE_REF }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Start response that hands out the session URL. */
const started = () =>
  new Response(null, { status: 200, headers: { "x-goog-upload-url": `${GOOGLE}${SESSION_PATH}` } });

/** `upload, finalize` response; override the status header or the body to test validation. */
const finalized = (status: string | null = "final", body: unknown = { file: FILE_REF }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: status === null ? {} : { "x-goog-upload-status": status },
  });

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

      const ref = await uploadLocalFile(file, { apiKey: "test-key-0000" });
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

  it("rejects Blobs above the 2 GB Files API limit before any request", async () => {
    class HugeBlob extends Blob {
      override get size(): number {
        return FILES_API_MAX_BYTES + 1;
      }
    }
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(FILES_API_MAX_BYTES).toBe(2_000_000_000);
    const err = await uploadFile(
      { blob: new HugeBlob(["x"]), displayName: "huge.mp4", mimeType: "video/mp4" },
      { apiKey: "test-key-0000" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/huge\.mp4 .*limit 2 GB/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads an in-memory Blob with the given name and type (no file system)", async () => {
    const bodies: unknown[] = [];
    const starts: RequestInit[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("upload_id=")) {
        bodies.push(init.body);
        return finalized();
      }
      starts.push(init);
      return started();
    });

    const blob = new Blob(["%PDF-1.4"]);
    const ref = await uploadFile(
      { blob, displayName: "report.pdf", mimeType: "application/pdf" },
      { apiKey: "test-key-0000" },
    );
    expect(ref).toEqual(FILE_REF);
    expect(bodies[0]).toBe(blob); // sent as is, never copied
    expect(headerOf(starts[0], "x-goog-upload-header-content-length")).toBe("8");
    expect(headerOf(starts[0], "x-goog-upload-header-content-type")).toBe("application/pdf");
    expect(JSON.parse(String(starts[0]?.body))).toEqual({ file: { display_name: "report.pdf" } });
  });

  it("sends a typed Blob without its type, so the byte upload has no Content-Type", async () => {
    const realFetch = globalThis.fetch;
    let server: Awaited<ReturnType<typeof startUploadServer>> | undefined;
    try {
      server = await startUploadServer();
      const local = `http://127.0.0.1:${server.port}`;
      vi.stubGlobal("fetch", (url: string, i: RequestInit) =>
        realFetch(url.replace(GOOGLE, local), i),
      );
      const blob = new File(["%PDF-1.4"], "report.pdf", { type: "application/x-other" });
      await uploadFile(
        { blob, displayName: "report.pdf", mimeType: "application/pdf" },
        { apiKey: "test-key-0000" },
      );
    } finally {
      await server?.close();
    }
    const upload = server?.received[1];
    expect(upload?.url).toBe(SESSION_PATH);
    expect(upload?.headers["content-type"]).toBeUndefined();
    expect(upload?.bytes).toBe(8);
    expect(upload?.head).toBe("%PDF-1.4");
    expect(server?.received[0]?.headers["x-goog-upload-header-content-type"]).toBe(
      "application/pdf",
    );
  });

  it.each([
    ["FAILED", 300_000, "File processing failed"],
    ["PROCESSING", 0, "Processing timeout"],
  ] as const)("names the source in the %s processing error", async (state, timeoutMs, text) => {
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, "x");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("upload_id=")
        ? finalized("final", { file: { ...FILE_REF, state, mimeType: "video/mp4" } })
        : started(),
    );

    // The CLI helper labels errors with the local path ...
    const local = await uploadLocalFile(file, { apiKey: "test-key-0000", timeoutMs }).catch(
      (e: unknown) => e,
    );
    expect(local).toBeInstanceOf(ProviderError);
    expect((local as Error).message).toBe(`${text}: ${file}`);

    // ... and the client falls back to the display name.
    const blob = await uploadFile(
      { blob: new Blob(["x"]), displayName: "clip.mp4", mimeType: "video/mp4" },
      { apiKey: "test-key-0000", timeoutMs },
    ).catch((e: unknown) => e);
    expect((blob as Error).message).toBe(`${text}: clip.mp4`);
  });

  it("rotates to the next key when the upload is rate-limited", async () => {
    vi.stubEnv("GEMINI_API_KEY", "key-a");
    vi.stubEnv("GEMINI_API_KEY_2", "key-b");
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");

    const keys: Array<string | undefined> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("upload_id=")) return finalized();
      const key = headerOf(init, "x-goog-api-key");
      keys.push(key);
      if (key === "key-a") return new Response("quota exceeded", { status: 429 });
      return new Response(null, {
        status: 200,
        headers: { "x-goog-upload-url": `${GOOGLE}${SESSION_PATH}` },
      });
    });

    const ref = await uploadLocalFile(file);
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

    const err = await uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).rawUrl).not.toContain("upload_id");
    expect(String((err as Error).message)).not.toContain("session-secret");
  });

  it("fails clearly when the start response has no upload URL", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));

    const err = await uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/no upload URL/);
  });

  /** Run an upload whose `step` request rejects with `failure`; the other step succeeds. */
  async function failAt(step: "start" | "upload", failure: unknown): Promise<unknown> {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async (url: string) => {
      const isUpload = url.includes("upload_id=");
      if ((step === "upload") === isUpload) throw failure;
      return isUpload ? finalized() : started();
    });
    return uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
  }

  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");

  it.each(["start", "upload"] as const)(
    "turns a network failure on %s into a transient HttpError(0) that keeps the cause",
    async (step) => {
      const failure = new TypeError("fetch failed", { cause: new Error("other side closed") });
      const err = await failAt(step, failure);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(0);
      expect(isTransientHttpError(err)).toBe(true);
      expect((err as HttpError).snippet).toBe(
        "File upload failed: fetch failed: other side closed",
      );
      expect((err as Error).cause).toBe(failure);
      expect((err as HttpError).rawUrl).not.toContain("upload_id");
      expect((err as Error).message).not.toContain("session-secret");
      expect((err as Error).message).not.toContain("test-key-0000");
    },
  );

  it("turns a timed-out start request into a transient HttpError(0)", async () => {
    const failure = timeout();
    const err = await failAt("start", failure);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as Error).message).toMatch(/File upload failed: timed out after 300 s$/);
    expect((err as Error).cause).toBe(failure);
  });

  it("keeps a timed-out byte upload as a non-retried ProviderError", async () => {
    const failure = timeout();
    const err = await failAt("upload", failure);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(isTransientHttpError(err)).toBe(false);
    expect((err as Error).message).toBe("File upload failed: timed out after 300 s");
    expect((err as Error).cause).toBe(failure);
  });

  it.each(["start", "upload"] as const)(
    "keeps a refused redirect on %s as a non-retried ProviderError",
    async (step) => {
      const failure = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      const err = await failAt(step, failure);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).not.toBeInstanceOf(HttpError); // must not trigger key rotation or retries
      expect((err as Error).message).toBe("File upload failed: fetch failed: unexpected redirect");
      expect((err as Error).cause).toBe(failure);
    },
  );

  it.each([
    ["a missing upload status", null, { file: FILE_REF }, /upload status is "missing"/],
    ["a non-final upload status", "active", { file: FILE_REF }, /upload status is "active"/],
    ["a response without a file", "final", {}, /no file in the response/],
    ["a file without a uri", "final", { file: { name: "files/abc" } }, /no file in the response/],
  ])("rejects a finalize response with %s", async (_label, status, body, detail) => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("upload_id=") ? finalized(status, body) : started(),
    );

    const err = await uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/^File upload failed: upload was not finalized/);
    expect((err as Error).message).toMatch(detail);
    expect((err as Error).message).not.toContain("session-secret");
  });

  it("rejects a finalized upload whose body is not JSON, without echoing it", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("upload_id=")
        ? new Response("<html>session-secret</html>", {
            status: 200,
            headers: { "x-goog-upload-status": "final" },
          })
        : started(),
    );

    const err = await uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toBe(
      "File upload failed: upload was not finalized (unreadable response body)",
    );
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("accepts the upload status header in any case", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("upload_id=") ? finalized("FINAL") : started(),
    );

    await expect(uploadLocalFile(file, { apiKey: "test-key-0000" })).resolves.toEqual(FILE_REF);
  });

  it.each(["abc", "0", "-5", "0.5", "Infinity"])(
    "rejects MULTIX_UPLOAD_MIN_KBPS=%s with a ConfigError before any request",
    async (value) => {
      vi.stubEnv("MULTIX_UPLOAD_MIN_KBPS", value);
      const file = path.join(dir, "doc.pdf");
      fs.writeFileSync(file, "%PDF-1.4");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const err = await uploadLocalFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("MULTIX_UPLOAD_MIN_KBPS");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("gemini client runtime neutrality", () => {
  it("client.ts reaches no Node built-ins, dotenv or process through its imports", () => {
    expect(formatNodeOnlyUses(findNodeOnlyUses("src/providers/gemini/client.ts"))).toEqual([]);
  });

  it("the import check catches Node-only modules (local-files.ts is Node-only)", () => {
    const found = formatNodeOnlyUses(findNodeOnlyUses("src/providers/gemini/local-files.ts"));
    expect(found).toContain('src/providers/gemini/local-files.ts: imports "node:fs"');
    expect(found).toContain(
      "src/providers/gemini/local-files.ts -> src/providers/gemini/key-pool.ts: uses process.",
    );
    expect(found.some((f) => f.endsWith('imports "dotenv"'))).toBe(true);
  });
});

describe("local file helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-local-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("inlinePart base64-encodes the file with its MIME type", () => {
    const file = path.join(dir, "pic.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(inlinePart(file)).toEqual({ inlineData: { mimeType: "image/png", data: "iVBORw==" } });
  });

  it("shouldUseFileApi switches to the Files API only above 20 MB", () => {
    const sized = (name: string, size: number) => {
      const file = path.join(dir, name);
      fs.closeSync(fs.openSync(file, "w"));
      fs.truncateSync(file, size);
      return file;
    };
    expect(INLINE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(shouldUseFileApi(sized("at.pdf", INLINE_MAX_BYTES))).toBe(false);
    expect(shouldUseFileApi(sized("over.pdf", INLINE_MAX_BYTES + 1))).toBe(true);
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

  it("uses the given upload speed", () => {
    expect(uploadTimeoutMs(500_000_000, 300_000, 250_000)).toBe(60_000 + 2_000_000);
  });
});

describe("minUploadBytesPerSec", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 1 MB/s", () => {
    vi.stubEnv("MULTIX_UPLOAD_MIN_KBPS", "");
    expect(minUploadBytesPerSec()).toBe(1_000_000);
  });

  it("reads MULTIX_UPLOAD_MIN_KBPS in kilobytes (1,000 bytes) per second", () => {
    vi.stubEnv("MULTIX_UPLOAD_MIN_KBPS", " 250 ");
    expect(minUploadBytesPerSec()).toBe(250_000);
  });
});
