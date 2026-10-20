import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  assertInteractionId,
  cancelInteraction,
  fileDownloadUrl,
  geminiFileNameFromUri,
  getFile,
  getInteraction,
} from "../../../../src/providers/gemini/client.js";

const HOST = "https://generativelanguage.googleapis.com";

describe("geminiFileNameFromUri", () => {
  it("returns the Files API resource name for the API host, with or without :download", () => {
    expect(geminiFileNameFromUri(`${HOST}/v1beta/files/abc-1_2:download?alt=media`)).toBe(
      "files/abc-1_2",
    );
    expect(geminiFileNameFromUri(`${HOST}/v1beta/files/abc`)).toBe("files/abc");
    expect(geminiFileNameFromUri(`${HOST}/v1beta/files/abc:download`)).toBe("files/abc");
  });

  it("rejects plain http, even on the API host", () => {
    expect(
      geminiFileNameFromUri("http://generativelanguage.googleapis.com/v1beta/files/abc"),
    ).toBeNull();
  });

  it("rejects other hosts, look-alike hosts and non-default ports", () => {
    for (const uri of [
      "https://storage.example.com/v1beta/files/abc:download?alt=media",
      "https://generativelanguage.googleapis.com.evil.example/v1beta/files/abc",
      "https://evil.example/generativelanguage.googleapis.com/v1beta/files/abc",
      "https://generativelanguage.googleapis.com:8443/v1beta/files/abc",
    ]) {
      expect(geminiFileNameFromUri(uri), uri).toBeNull();
    }
  });

  it("rejects paths other than /v1beta/files/<id>", () => {
    for (const uri of [
      `${HOST}/v1/files/abc`,
      `${HOST}/v1beta/models/abc`,
      `${HOST}/v1beta/files/`,
      `${HOST}/v1beta/files/abc/extra`,
      `${HOST}/v1beta/files/abc:delete`,
      `${HOST}/v1beta/files/abc%2F..`,
      `${HOST}/v1beta/files/../models/x`,
      `${HOST}/v1beta/files/${"a".repeat(257)}`,
    ]) {
      expect(geminiFileNameFromUri(uri), uri).toBeNull();
    }
  });

  it("returns null for strings that are not URLs", () => {
    expect(geminiFileNameFromUri("")).toBeNull();
    expect(geminiFileNameFromUri("files/abc")).toBeNull();
    expect(geminiFileNameFromUri("not a url")).toBeNull();
  });
});

describe("fileDownloadUrl and getFile names", () => {
  it("builds the media download URL for a valid file name", () => {
    expect(fileDownloadUrl("files/abc")).toBe(`${HOST}/v1beta/files/abc:download?alt=media`);
  });

  it("rejects file names that could leave the files/ collection", () => {
    for (const name of ["abc", "files/../models/x", "files/a/b", "files/a?x=1", "files/"]) {
      expect(() => fileDownloadUrl(name), name).toThrow(ValidationError);
    }
  });
});

describe("assertInteractionId", () => {
  it("accepts URL-safe ids and trims surrounding whitespace", () => {
    expect(assertInteractionId("v1_Chdl-XYZ_09")).toBe("v1_Chdl-XYZ_09");
    expect(assertInteractionId("  v1_abc  ")).toBe("v1_abc");
    expect(assertInteractionId("a".repeat(512))).toHaveLength(512);
  });

  it("rejects path traversal, query injection and other unsafe characters", () => {
    for (const id of [
      "../etc",
      "v1/../x",
      "v1?x=1",
      "v1#frag",
      "v1%2F..",
      "v1 2",
      "",
      "a".repeat(513),
    ]) {
      expect(() => assertInteractionId(id), JSON.stringify(id)).toThrow(ValidationError);
    }
  });

  it("reports the rejected id with a bounded length", () => {
    expect(() => assertInteractionId(`../${"x".repeat(200)}`)).toThrow(
      /^Invalid interaction id: \.\.\/x{77}$/,
    );
  });
});

describe("interaction and file calls with unsafe ids", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never sends a request for a traversal interaction id", async () => {
    await expect(getInteraction("../models/x", { apiKey: "test-key-1" })).rejects.toThrow(
      ValidationError,
    );
    await expect(cancelInteraction("v1/../x", { apiKey: "test-key-1" })).rejects.toThrow(
      ValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends a request for an invalid file name", async () => {
    await expect(getFile("models/x", { apiKey: "test-key-1" })).rejects.toThrow(ValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the key only in the x-goog-api-key header, never in the URL", async () => {
    await getInteraction("v1_ok", { apiKey: "test-key-1" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOST}/v1beta/interactions/v1_ok`);
    expect(url).not.toContain("test-key-1");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("test-key-1");
  });
});
