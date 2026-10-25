import { describe, expect, it, vi } from "vitest";
import { HttpError, ValidationError } from "../../../../src/core/errors.js";
import {
  FAL_MULTIPART_THRESHOLD,
  FAL_REST_URL,
  parseFalExpiry,
  uploadToFalStorage,
} from "../../../../src/providers/fal/storage.js";

const UPLOAD_URL = "https://upload.fal.test/files/abc?X-Signature=secret-sig";
const FILE_URL = "https://v3.fal.media/files/abc/shot.mp4";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** fetch stub: initiate returns the signed URL; `put` decides the PUT responses. */
function storageFetch(put: (call: Call, n: number) => Response, initiate?: () => Response) {
  const calls: Call[] = [];
  let puts = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headersOf(init),
      body: init?.body,
    };
    calls.push(call);
    if (call.url.includes("/storage/upload/initiate")) {
      return (
        initiate?.() ??
        new Response(JSON.stringify({ upload_url: UPLOAD_URL, file_url: FILE_URL }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    puts++;
    return put(call, puts);
  });
  return { fetch, calls };
}

const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" });

describe("uploadToFalStorage", () => {
  it("initiates with the key on rest.fal.ai and PUTs the bytes without it", async () => {
    const { fetch, calls } = storageFetch(() => new Response("", { status: 200 }));
    const url = await uploadToFalStorage({
      apiKey: "fal-secret-key",
      data: blob,
      fileName: "shot.mp4",
      contentType: "video/mp4",
      fetch,
    });
    expect(url).toBe(FILE_URL);
    expect(calls).toHaveLength(2);
    const [init, put] = calls as [Call, Call];
    expect(init.url).toBe(`${FAL_REST_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Key fal-secret-key");
    expect(JSON.parse(String(init.body))).toEqual({
      content_type: "video/mp4",
      file_name: "shot.mp4",
    });
    expect(put.url).toBe(UPLOAD_URL);
    expect(put.method).toBe("PUT");
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers["content-type"]).toBe("video/mp4");
    expect(put.body).toBe(blob);
  });

  it("sends the lifecycle header when an expiry is set", async () => {
    const { fetch, calls } = storageFetch(() => new Response("", { status: 200 }));
    await uploadToFalStorage({
      apiKey: "k",
      data: blob,
      fileName: "a.mp4",
      contentType: "video/mp4",
      expiresInSeconds: 3600,
      fetch,
    });
    expect(JSON.parse(calls[0]?.headers["x-fal-object-lifecycle"] ?? "")).toEqual({
      expiration_duration_seconds: 3600,
    });
  });

  it("retries a failed PUT and never leaks the signed query string", async () => {
    const { fetch, calls } = storageFetch((_c, n) =>
      n === 1 ? new Response("busy", { status: 503 }) : new Response("", { status: 200 }),
    );
    await uploadToFalStorage({
      apiKey: "k",
      data: blob,
      fileName: "a.mp4",
      contentType: "video/mp4",
      fetch,
    });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);

    const failing = storageFetch(() => new Response("nope", { status: 403 }));
    const err = await uploadToFalStorage({
      apiKey: "k",
      data: blob,
      fileName: "a.mp4",
      contentType: "video/mp4",
      fetch: failing.fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(String((err as Error).message)).not.toContain("secret-sig");
    // 403 is not retried.
    expect(failing.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("does not retry an auth failure on initiate", async () => {
    const { fetch, calls } = storageFetch(
      () => new Response("", { status: 200 }),
      () => new Response('{"detail":"Invalid key"}', { status: 401 }),
    );
    await expect(
      uploadToFalStorage({
        apiKey: "bad",
        data: blob,
        fileName: "a.mp4",
        contentType: "video/mp4",
        fetch,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("refuses a non-https upload URL instead of sending the file there", async () => {
    const { fetch, calls } = storageFetch(
      () => new Response("", { status: 200 }),
      () =>
        new Response(JSON.stringify({ upload_url: "http://evil.test/up", file_url: FILE_URL }), {
          status: 200,
        }),
    );
    await expect(
      uploadToFalStorage({
        apiKey: "k",
        data: blob,
        fileName: "a.mp4",
        contentType: "video/mp4",
        fetch,
      }),
    ).rejects.toThrow(/upload_url/);
    expect(calls).toHaveLength(1);
  });

  it("uploads large files in 10 MB parts and completes the multipart upload", async () => {
    const big = new Blob([new Uint8Array(FAL_MULTIPART_THRESHOLD + 1)]);
    const { fetch, calls } = storageFetch((call) =>
      call.url.includes("/complete")
        ? new Response("{}", { status: 200 })
        : new Response(
            JSON.stringify({ partNumber: Number(call.url.match(/\/(\d+)\?/)?.[1]), etag: "e" }),
            {
              status: 200,
            },
          ),
    );
    const url = await uploadToFalStorage({
      apiKey: "k",
      data: big,
      fileName: "big.mp4",
      contentType: "video/mp4",
      fetch,
    });
    expect(url).toBe(FILE_URL);
    expect(calls[0]?.url).toContain("/storage/upload/initiate-multipart?");
    const parts = calls.filter((c) => c.method === "PUT");
    expect(parts).toHaveLength(Math.ceil((FAL_MULTIPART_THRESHOLD + 1) / (10 * 1024 * 1024)));
    expect(parts[0]?.url).toBe("https://upload.fal.test/files/abc/1?X-Signature=secret-sig");
    expect(parts.every((p) => p.headers.authorization === undefined)).toBe(true);
    const complete = calls.at(-1) as Call;
    expect(complete.url).toBe("https://upload.fal.test/files/abc/complete?X-Signature=secret-sig");
    expect(JSON.parse(String(complete.body)).parts).toHaveLength(parts.length);
  });
});

describe("parseFalExpiry", () => {
  it("accepts presets and seconds", () => {
    expect(parseFalExpiry("1h")).toBe(3600);
    expect(parseFalExpiry("7D")).toBe(604800);
    expect(parseFalExpiry("never")).toBeUndefined();
    expect(parseFalExpiry("90")).toBe(90);
  });

  it("rejects anything else", () => {
    expect(() => parseFalExpiry("soon")).toThrow(ValidationError);
    expect(() => parseFalExpiry("0")).toThrow(ValidationError);
    expect(() => parseFalExpiry("-5")).toThrow(ValidationError);
  });
});
