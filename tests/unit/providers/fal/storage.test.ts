/**
 * fal storage upload client: the official initiate + PUT protocol, multipart
 * for large files, retries, and that the key never reaches the upload URL.
 * fetch is injected; no network.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { parseExpiresIn, uploadToFalStorage } from "../../../../src/providers/fal/storage.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect?: RequestRedirect;
}

const UPLOAD = "https://storage.fal.test/upload/abc?sig=SECRET";
const FILE_URL = "https://v3b.fal.media/files/b/abc_shot.mp4";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake fetch answering by "METHOD path-prefix"; records each call. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const file = () => new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "video/mp4" });

describe("uploadToFalStorage", () => {
  it("initiates with the key, then PUTs the bytes to the signed URL without it", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes("/storage/upload/initiate")
        ? json({ upload_url: UPLOAD, file_url: FILE_URL })
        : new Response(null, { status: 200 }),
    );
    const url = await uploadToFalStorage({
      file: file(),
      fileName: "shot.mp4",
      contentType: "video/mp4",
      apiKey: "fal-secret",
      fetch,
    });
    expect(url).toBe(FILE_URL);
    expect(calls).toHaveLength(2);
    const [init, put] = calls;
    expect(init?.url).toBe("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3");
    expect(init?.method).toBe("POST");
    expect(init?.headers.authorization).toBe("Key fal-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      content_type: "video/mp4",
      file_name: "shot.mp4",
    });
    expect(init?.headers["x-fal-object-lifecycle"]).toBeUndefined();
    expect(put?.url).toBe(UPLOAD);
    expect(put?.method).toBe("PUT");
    expect(put?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(put?.headers)).not.toContain("fal-secret");
    expect(put?.headers["content-type"]).toBe("video/mp4");
    expect(put?.redirect).toBe("error");
    expect(put?.body).toBeInstanceOf(Blob);
  });

  it("sends the lifecycle header when an expiry is requested", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.method === "POST"
        ? json({ upload_url: UPLOAD, file_url: FILE_URL })
        : new Response(null, { status: 200 }),
    );
    await uploadToFalStorage({
      file: file(),
      fileName: "a.mp4",
      contentType: "video/mp4",
      apiKey: "k",
      expiresInSeconds: 3600,
      fetch,
    });
    expect(JSON.parse(calls[0]?.headers["x-fal-object-lifecycle"] ?? "{}")).toEqual({
      expiration_duration_seconds: 3600,
    });
  });

  it("refuses a non-https upload URL before sending any bytes", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ upload_url: "http://storage.fal.test/u", file_url: FILE_URL }),
    );
    await expect(
      uploadToFalStorage({ file: file(), fileName: "a", contentType: "x/y", apiKey: "k", fetch }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it("retries network failures and 5xx, but not 401", async () => {
    let puts = 0;
    const { fetch } = fakeFetch((c) => {
      if (c.method === "POST") return json({ upload_url: UPLOAD, file_url: FILE_URL });
      puts++;
      if (puts === 1) throw new TypeError("fetch failed");
      if (puts === 2) return new Response("busy", { status: 503 });
      return new Response(null, { status: 200 });
    });
    const url = await uploadToFalStorage({
      file: file(),
      fileName: "a.mp4",
      contentType: "video/mp4",
      apiKey: "k",
      backoffMs: () => 0,
      fetch,
    });
    expect(url).toBe(FILE_URL);
    expect(puts).toBe(3);

    const denied = fakeFetch(() => json({ detail: "Invalid key" }, 401));
    await expect(
      uploadToFalStorage({
        file: file(),
        fileName: "a.mp4",
        contentType: "video/mp4",
        apiKey: "revoked",
        backoffMs: () => 0,
        fetch: denied.fetch,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(denied.calls).toHaveLength(1);
  });

  it("gives up after the configured attempts", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      uploadToFalStorage({
        file: file(),
        fileName: "a",
        contentType: "x/y",
        apiKey: "k",
        attempts: 2,
        backoffMs: () => 0,
        fetch,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(2);
  });

  it("uses multipart parts and completes them for files over the threshold", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.includes("/initiate-multipart")) {
        return json({ upload_url: UPLOAD, file_url: FILE_URL });
      }
      const part = c.url.match(/\/upload\/abc\/(\d+)\?/)?.[1];
      if (part) return json({ partNumber: Number(part), etag: `etag-${part}` });
      return json({});
    });
    const url = await uploadToFalStorage({
      file: file(),
      fileName: "big.mp4",
      contentType: "video/mp4",
      apiKey: "k",
      multipartThresholdBytes: 4,
      partSizeBytes: 2,
      fetch,
    });
    expect(url).toBe(FILE_URL);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://rest.fal.ai/storage/upload/initiate-multipart?storage_type=fal-cdn-v3",
      "PUT https://storage.fal.test/upload/abc/1?sig=SECRET",
      "PUT https://storage.fal.test/upload/abc/2?sig=SECRET",
      "PUT https://storage.fal.test/upload/abc/3?sig=SECRET",
      "POST https://storage.fal.test/upload/abc/complete?sig=SECRET",
    ]);
    expect(JSON.parse(String(calls[4]?.body))).toEqual({
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 3, etag: "etag-3" },
      ],
    });
    expect(calls.slice(1).every((c) => c.headers.authorization === undefined)).toBe(true);
    expect((calls[3]?.body as Blob).size).toBe(1);
  });
});

describe("parseExpiresIn", () => {
  it("maps named lifetimes and seconds", () => {
    expect(parseExpiresIn("1h")).toBe(3600);
    expect(parseExpiresIn("7D")).toBe(604800);
    expect(parseExpiresIn("never")).toBeUndefined();
    expect(parseExpiresIn("120")).toBe(120);
  });

  it("rejects anything else as invalid input", () => {
    for (const bad of ["0", "-5", "2w", "", "1.5"]) {
      expect(() => parseExpiresIn(bad)).toThrow(ValidationError);
    }
  });
});
