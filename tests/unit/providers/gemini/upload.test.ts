import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, ValidationError } from "../../../../src/core/errors.js";
import { FILES_API_MAX_BYTES, uploadFile } from "../../../../src/providers/gemini/client.js";

const FILE_REF = {
  name: "files/abc",
  uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
  state: "ACTIVE",
  mimeType: "application/pdf",
};

interface Received {
  bytes: number;
  contentLength?: string;
  contentType?: string;
  head: string;
  tail: string;
}

/** Local server that drains the request body without keeping it. */
async function startDrainServer(): Promise<{
  port: number;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const r: Received = {
      bytes: 0,
      contentLength: req.headers["content-length"],
      contentType: req.headers["content-type"],
      head: "",
      tail: "",
    };
    req.on("data", (chunk: Buffer) => {
      r.bytes += chunk.length;
      if (r.head.length < 512) r.head += chunk.subarray(0, 512).toString("latin1");
      r.tail = (r.tail + chunk.subarray(-64).toString("latin1")).slice(-64);
    });
    req.on("end", () => {
      received.push(r);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ file: FILE_REF }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe("gemini uploadFile streaming", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-upload-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("streams the file through real fetch without allocating a file-sized buffer", async () => {
    const file = path.join(dir, "doc.pdf");
    const size = 256 * 1024 * 1024;
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, size); // zero-filled without allocating it in the test

    const readSync = vi.spyOn(fs, "readFileSync");
    const readAsync = vi.spyOn(fs.promises, "readFile");

    const server = await startDrainServer();
    const realFetch = globalThis.fetch;
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", (url: string, i: RequestInit) => {
      init = i;
      const local = url.replace(
        "https://generativelanguage.googleapis.com",
        `http://127.0.0.1:${server.port}`,
      );
      return realFetch(local, i);
    });

    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 1);
    try {
      const ref = await uploadFile(file, { apiKey: "test-key-0000" });
      expect(ref).toEqual(FILE_REF);
    } finally {
      clearInterval(sampler);
      await server.close();
    }
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);

    expect(readSync).not.toHaveBeenCalled();
    expect(readAsync).not.toHaveBeenCalled();
    // A buffered upload holds at least one full copy of the file. Short-lived chunk garbage
    // plateaus well below half of it, because V8 collects every ~64 MB of external memory.
    expect(peak - before).toBeLessThan(size / 2);
    // Following redirects makes fetch tee the body, and the copy retains every chunk.
    expect(init?.redirect).toBe("error");

    // The multipart envelope wraps the exact file bytes, and Content-Length matches.
    const r = server.received[0];
    expect(r).toBeDefined();
    if (!r) return;
    const boundary = (r.contentType ?? "").split("boundary=")[1] ?? "";
    expect(boundary).not.toBe("");
    const closing = `\r\n--${boundary}--`;
    expect(
      r.head.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8`),
    ).toBe(true);
    expect(r.head).toContain('"displayName":"doc.pdf"');
    const mediaHeader = "Content-Type: application/pdf\r\n\r\n";
    const headLength = r.head.indexOf(mediaHeader) + mediaHeader.length;
    expect(headLength).toBeGreaterThan(mediaHeader.length);
    expect(r.tail.endsWith(closing)).toBe(true);
    expect(r.bytes).toBe(headLength + size + closing.length);
    expect(r.contentLength).toBe(String(r.bytes));
  });

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

    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/huge\.mp4 .*limit 2048 MB/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still throws HttpError with the status when the upload fails", async () => {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, "%PDF-1.4");
    vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 429 }));

    const err = await uploadFile(file, { apiKey: "test-key-0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
  });
});
