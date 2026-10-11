import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  assertPredictionId,
  describeModelRef,
  isTerminalStatus,
  parseModelRef,
} from "../../../../src/providers/replicate/models.js";
import {
  extFromContentType,
  extFromUrl,
  extractOutput,
  mimeFromFilename,
  outputFilename,
  summarizePrediction,
} from "../../../../src/providers/replicate/output.js";
import type { ReplicatePrediction } from "../../../../src/providers/replicate/types.js";

const VERSION = "a".repeat(64);

describe("runtime-neutral Replicate modules", () => {
  const files = ["client.ts", "types.ts", "models.ts", "output.ts"];
  it.each(files)("%s has no node:* imports or Node-only core imports", (file) => {
    const src = fs.readFileSync(path.resolve("src/providers/replicate", file), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(
      /from\s+["'][^"']*(env-loader|http-client|logger|output-dir|json-input)/,
    );
    expect(src).not.toMatch(/process\./);
  });
});

describe("parseModelRef", () => {
  it("parses official owner/name", () => {
    expect(parseModelRef("black-forest-labs/flux-schnell")).toEqual({
      kind: "official",
      owner: "black-forest-labs",
      name: "flux-schnell",
    });
  });

  it("parses owner/name:version and bare version ids", () => {
    expect(parseModelRef(`a/b:${VERSION}`)).toEqual({
      kind: "version",
      version: VERSION,
      owner: "a",
      name: "b",
    });
    expect(parseModelRef(VERSION)).toEqual({ kind: "version", version: VERSION });
    expect(parseModelRef("a/b", "abc123")).toMatchObject({ kind: "version", version: "abc123" });
  });

  it("rejects malformed refs and conflicting versions", () => {
    for (const bad of ["flux", "a/b/c", "a/b:c:d", "/b", "a/", "a b/c", "a/b:ver-1"]) {
      expect(() => parseModelRef(bad)).toThrow(ValidationError);
    }
    expect(() => parseModelRef(`a/b:${VERSION}`, "other")).toThrow(/Conflicting/);
    expect(() => parseModelRef("a/b", "bad/id")).toThrow(ValidationError);
  });

  it("describes refs for logs", () => {
    expect(describeModelRef(parseModelRef("a/b"))).toBe("a/b");
    expect(describeModelRef(parseModelRef(`a/b:${VERSION}`))).toBe("a/b:aaaaaaaaaaaa");
  });
});

describe("status and id helpers", () => {
  it("knows the terminal statuses", () => {
    for (const s of ["succeeded", "failed", "canceled", "aborted"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of ["starting", "processing", undefined]) expect(isTerminalStatus(s)).toBe(false);
  });

  it("validates prediction ids", () => {
    expect(assertPredictionId(" abc123 ")).toBe("abc123");
    expect(() => assertPredictionId("a/b")).toThrow(ValidationError);
    expect(() => assertPredictionId("")).toThrow(ValidationError);
  });
});

describe("extractOutput", () => {
  it("handles a single URL string", () => {
    expect(extractOutput("https://replicate.delivery/x/out.mp4")).toEqual({
      media: [{ url: "https://replicate.delivery/x/out.mp4", path: "output" }],
      texts: [],
    });
  });

  it("handles URL arrays in order", () => {
    const out = extractOutput(["https://r/1.webp", "https://r/2.webp"]);
    expect(out.media.map((m) => m.url)).toEqual(["https://r/1.webp", "https://r/2.webp"]);
    expect(out.media.map((m) => m.path)).toEqual(["[0]", "[1]"]);
  });

  it("handles nested objects with media and scalar metadata", () => {
    const out = extractOutput({
      video: "https://r/v.mp4",
      frames: [{ url: "https://r/f.png" }],
      seed: 42,
      caption: "a cube",
    });
    expect(out.media.map((m) => m.path)).toEqual(["video", "frames[0].url"]);
    expect(out.texts).toEqual(["seed: 42", "caption: a cube"]);
  });

  it("joins language-model token arrays and keeps plain text", () => {
    expect(extractOutput(["Hel", "lo", "!"]).texts).toEqual(["Hello!"]);
    expect(extractOutput("just text")).toEqual({ media: [], texts: ["just text"] });
  });

  it("treats data URIs as media and ignores null output", () => {
    expect(extractOutput("data:image/png;base64,AAAA").media).toHaveLength(1);
    expect(extractOutput(null)).toEqual({ media: [], texts: [] });
  });
});

describe("file type inference", () => {
  it("infers extensions from URL paths, data URIs, and content types", () => {
    expect(extFromUrl("https://replicate.delivery/a/out-0.WEBP?sig=1")).toBe(".webp");
    expect(extFromUrl("https://replicate.delivery/a/output")).toBeUndefined();
    expect(extFromUrl("data:video/mp4;base64,AAAA")).toBe(".mp4");
    expect(extFromContentType("image/jpeg; charset=binary")).toBe(".jpg");
    expect(extFromContentType("application/x-unknown")).toBeUndefined();
    expect(mimeFromFilename("photo.JPG")).toBe("image/jpeg");
    expect(mimeFromFilename("blob")).toBe("application/octet-stream");
  });

  it("names outputs replicate-<id8>-NN<ext>", () => {
    expect(outputFilename("abcdefghijk", 0, ".png")).toBe("replicate-abcdefgh-01.png");
    expect(outputFilename("abcdefghijk", 11, ".mp4")).toBe("replicate-abcdefgh-12.mp4");
    expect(outputFilename("/../../x", 0, ".png")).toBe("replicate-x-01.png");
    expect(outputFilename("../..", 0, ".png")).toBe("replicate-output-01.png");
  });
});

describe("summarizePrediction", () => {
  it("omits input and logs and redacts signed output URLs", () => {
    const summary = summarizePrediction({
      id: "p",
      status: "succeeded",
      input: { prompt: "private", image: "data:image/png;base64,AAAA" },
      logs: "seed 1",
      output: [
        "https://r.test/1.png?X-Amz-Signature=SECRET",
        { mask: "data:image/png;base64,AAAA" },
      ],
      urls: { web: "https://replicate.com/p/p" },
    } as ReplicatePrediction);
    expect(summary).toEqual({
      id: "p",
      status: "succeeded",
      output: ["https://r.test/1.png?[redacted]", { mask: "data:image/png;base64,[redacted]" }],
      web_url: "https://replicate.com/p/p",
    });
  });
});
