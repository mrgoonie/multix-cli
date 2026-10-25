import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  applyFileFields,
  checkLocalFile,
  isRemoteRef,
  parseFileSpecs,
  setInputField,
  uploadLocalFile,
} from "../../../../src/providers/fal/local-files.js";

const logger = {
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  header: vi.fn(),
};

let dir: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-local-"));
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

function stubStorage() {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (url.includes("/storage/upload/initiate")) {
      n++;
      return new Response(
        JSON.stringify({
          upload_url: `https://upload.fal.test/u${n}?sig=s`,
          file_url: `https://v3.fal.media/files/f${n}`,
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return calls;
}

describe("parseFileSpecs", () => {
  it("parses field=path pairs", () => {
    expect(parseFileSpecs(["video_url=./shot.mp4", "a.b=c=d.png"])).toEqual([
      { field: "video_url", value: "./shot.mp4" },
      { field: "a.b", value: "c=d.png" },
    ]);
  });

  it("rejects malformed and duplicate specs", () => {
    expect(() => parseFileSpecs(["shot.mp4"])).toThrow(ValidationError);
    expect(() => parseFileSpecs(["=shot.mp4"])).toThrow(ValidationError);
    expect(() => parseFileSpecs(["video_url="])).toThrow(ValidationError);
    expect(() => parseFileSpecs(["a..b=x"])).toThrow(ValidationError);
    expect(() => parseFileSpecs(["v=a", "v=b"])).toThrow(/given twice/);
  });
});

describe("setInputField", () => {
  it("sets top-level, nested and array fields", () => {
    const input: Record<string, unknown> = { prompt: "p", refs: [{ url: "old" }] };
    setInputField(input, "video_url", "u1");
    setInputField(input, "audio.source_url", "u2");
    setInputField(input, "refs.0.url", "u3");
    setInputField(input, "refs.1", "u4");
    expect(input).toEqual({
      prompt: "p",
      video_url: "u1",
      audio: { source_url: "u2" },
      refs: [{ url: "u3" }, "u4"],
    });
  });

  it("refuses prototype keys and paths through scalars", () => {
    expect(() => setInputField({}, "__proto__.x", "u")).toThrow(ValidationError);
    expect(() => setInputField({ prompt: "p" }, "prompt.x", "u")).toThrow(/not an object/);
    expect(() => setInputField({ a: [] }, "a.x", "u")).toThrow(/not an index/);
  });
});

describe("checkLocalFile", () => {
  it("rejects missing, empty and directory paths", () => {
    expect(() => checkLocalFile(path.join(dir, "nope.mp4"))).toThrow(/File not found/);
    const empty = path.join(dir, "empty.mp4");
    fs.writeFileSync(empty, "");
    expect(() => checkLocalFile(empty)).toThrow(/empty/);
    expect(() => checkLocalFile(dir)).toThrow(/Not a regular file/);
  });

  it("tells URLs and data URIs from local paths", () => {
    expect(isRemoteRef("https://x.test/a.mp4")).toBe(true);
    expect(isRemoteRef("data:video/mp4;base64,AA")).toBe(true);
    expect(isRemoteRef("./https.mp4")).toBe(false);
  });
});

describe("uploadLocalFile / applyFileFields", () => {
  it("uploads a local file and reports url, name, MIME type and size", async () => {
    const file = path.join(dir, "shot.mp4");
    fs.writeFileSync(file, Buffer.alloc(1234, 7));
    const calls = stubStorage();
    const res = await uploadLocalFile(file, { apiKey: "k", logger });
    expect(res).toEqual({
      url: "https://v3.fal.media/files/f1",
      file_name: "shot.mp4",
      mime_type: "video/mp4",
      size_bytes: 1234,
    });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      content_type: "video/mp4",
      file_name: "shot.mp4",
    });
    const put = calls[1];
    expect(put?.auth).toBeNull();
    expect((put?.body as Blob).size).toBe(1234);
    // The local file is untouched.
    expect(fs.readFileSync(file)).toEqual(Buffer.alloc(1234, 7));
  });

  it("fills each named field, keeps URLs as given and warns once about public URLs", async () => {
    const shot = path.join(dir, "shot.mp4");
    const ref = path.join(dir, "ref.png");
    fs.writeFileSync(shot, "v");
    fs.writeFileSync(ref, "i");
    stubStorage();
    const input: Record<string, unknown> = { prompt: "rain" };
    const uploads = await applyFileFields(
      input,
      parseFileSpecs([`video_url=${shot}`, "audio_url=https://x.test/a.wav", `image_url=${ref}`]),
      { apiKey: "k", logger },
    );
    expect(input).toEqual({
      prompt: "rain",
      video_url: "https://v3.fal.media/files/f1",
      audio_url: "https://x.test/a.wav",
      image_url: "https://v3.fal.media/files/f2",
    });
    expect(uploads.map((u) => u.field)).toEqual(["video_url", "image_url"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("checks every path before uploading any", async () => {
    const shot = path.join(dir, "shot.mp4");
    fs.writeFileSync(shot, "v");
    const calls = stubStorage();
    await expect(
      applyFileFields({}, parseFileSpecs([`video_url=${shot}`, `image_url=${dir}/missing.png`]), {
        apiKey: "k",
        logger,
      }),
    ).rejects.toThrow(/File not found/);
    expect(calls).toHaveLength(0);
  });
});
