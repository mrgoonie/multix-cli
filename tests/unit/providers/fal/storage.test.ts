import { describe, expect, it } from "vitest";
import { HttpError, ProviderError } from "../../../../src/core/errors.js";
import {
  FAL_MULTIPART_THRESHOLD_BYTES,
  FAL_PART_BYTES,
  uploadToFalStorage,
} from "../../../../src/providers/fal/storage.js";
import { FILE_URL, INITIATE, KEY, UPLOAD_URL, createFakeFal } from "./fake-fal.js";

const noSleep = async () => {};

function upload(fetch: ReturnType<typeof createFakeFal>["fetch"], file = new Blob(["video"])) {
  return uploadToFalStorage({
    apiKey: KEY,
    file,
    fileName: "shot.mp4",
    contentType: "video/mp4",
    fetch,
    sleep: noSleep,
  });
}

describe("uploadToFalStorage", () => {
  it("initiates with the key, then PUTs the bytes to the signed URL without it", async () => {
    const fake = createFakeFal({
      [`POST ${INITIATE}`]: [{ json: { upload_url: UPLOAD_URL, file_url: FILE_URL } }],
      "PUT https://storage.example-cdn.test/": [{ status: 200 }],
    });
    await expect(upload(fake.fetch)).resolves.toBe(FILE_URL);

    const [init, put] = fake.calls;
    expect(init?.url).toBe(`${INITIATE}?storage_type=fal-cdn-v3`);
    expect(init?.headers.authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      content_type: "video/mp4",
      file_name: "shot.mp4",
    });
    expect(put?.method).toBe("PUT");
    expect(put?.url).toBe(UPLOAD_URL);
    expect(put?.headers.authorization).toBeUndefined();
    expect(put?.headers["content-type"]).toBe("video/mp4");
    expect(put?.body).toBeInstanceOf(Blob);
  });

  it("retries a transient PUT failure and keeps the same file", async () => {
    const fake = createFakeFal({
      [`POST ${INITIATE}`]: [{ json: { upload_url: UPLOAD_URL, file_url: FILE_URL } }],
      "PUT https://storage.example-cdn.test/": [
        { status: 503 },
        { error: new TypeError("fetch failed") },
        { status: 200 },
      ],
    });
    await expect(upload(fake.fetch)).resolves.toBe(FILE_URL);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(3);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("gives up after the attempts are spent", async () => {
    const fake = createFakeFal({
      [`POST ${INITIATE}`]: [{ json: { upload_url: UPLOAD_URL, file_url: FILE_URL } }],
      "PUT https://storage.example-cdn.test/": [{ status: 502 }],
    });
    await expect(upload(fake.fetch)).rejects.toBeInstanceOf(HttpError);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(3);
  });

  it("does not retry a rejected key, and the error hides the signed query", async () => {
    const fake = createFakeFal({
      [`POST ${INITIATE}`]: [{ status: 401, json: { detail: "Invalid key" } }],
    });
    const err = await upload(fake.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect(String(err.message)).not.toContain(KEY);
    expect(fake.calls).toHaveLength(1);
  });

  it("never logs the signed upload URL in a PUT failure", async () => {
    const fake = createFakeFal({
      [`POST ${INITIATE}`]: [{ json: { upload_url: UPLOAD_URL, file_url: FILE_URL } }],
      "PUT https://storage.example-cdn.test/": [{ status: 403 }],
    });
    const err = await upload(fake.fetch).catch((e) => e);
    expect(String(err.message)).not.toContain("X-Goog-Signature=sig");
  });

  it("refuses a non-https upload or file URL before sending any bytes", async () => {
    for (const json of [
      { upload_url: "http://storage.example-cdn.test/u", file_url: FILE_URL },
      { upload_url: UPLOAD_URL, file_url: "http://v3.fal.media/f" },
      { upload_url: UPLOAD_URL },
    ]) {
      const fake = createFakeFal({ [`POST ${INITIATE}`]: [{ json }] });
      await expect(upload(fake.fetch)).rejects.toBeInstanceOf(ProviderError);
      expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
    }
  });

  it("uses the multipart flow above the threshold", async () => {
    // A Blob that reports a large size without allocating it.
    class LargeBlob extends Blob {
      override get size() {
        return FAL_MULTIPART_THRESHOLD_BYTES + 1;
      }
      override slice(start?: number) {
        return new Blob([`part@${start}`]);
      }
    }
    const fake = createFakeFal({
      "POST https://rest.fal.ai/storage/upload/initiate-multipart": [
        { json: { upload_url: UPLOAD_URL, file_url: FILE_URL } },
      ],
      "PUT https://storage.example-cdn.test/upload/abc/": [{ json: { partNumber: 1, etag: "e" } }],
      "POST https://storage.example-cdn.test/upload/abc/complete": [{ status: 200 }],
    });
    await expect(upload(fake.fetch, new LargeBlob(["x"]))).resolves.toBe(FILE_URL);

    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(Math.ceil((FAL_MULTIPART_THRESHOLD_BYTES + 1) / FAL_PART_BYTES));
    expect(puts[0]?.url).toBe("https://storage.example-cdn.test/upload/abc/1?X-Goog-Signature=sig");
    for (const c of fake.calls.slice(1)) expect(c.headers.authorization).toBeUndefined();
    const complete = fake.calls.at(-1);
    expect(complete?.url).toBe(
      "https://storage.example-cdn.test/upload/abc/complete?X-Goog-Signature=sig",
    );
    expect(JSON.parse(String(complete?.body)).parts).toHaveLength(puts.length);
  });
});
