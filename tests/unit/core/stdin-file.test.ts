import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  detectExtension,
  resolveFileInputs,
  stdinToTempFile,
} from "../../../src/core/stdin-file.js";

const bytes = (...parts: Array<string | number[]>) =>
  Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
  );

const piped = (...chunks: Buffer[]) => Readable.from(chunks);

describe("detectExtension", () => {
  it.each([
    [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ".png"],
    [bytes([0xff, 0xd8, 0xff, 0xe0]), ".jpg"],
    [bytes("GIF89a"), ".gif"],
    [bytes("%PDF-1.7"), ".pdf"],
    [bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), ".webp"],
    [bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "), ".wav"],
    [bytes("OggS", [0]), ".ogg"],
    [bytes("fLaC"), ".flac"],
    [bytes("ID3", [4, 0]), ".mp3"],
    [bytes([0xff, 0xfb, 0x90, 0x00]), ".mp3"],
    [bytes([0xff, 0xf1, 0x50, 0x80]), ".aac"],
    [bytes([0, 0, 0, 0x20], "ftypisom"), ".mp4"],
    [bytes([0, 0, 0, 0x20], "ftypM4A "), ".m4a"],
    [bytes([0, 0, 0, 0x14], "ftypqt  "), ".mov"],
    [bytes([0x1a, 0x45, 0xdf, 0xa3]), ".webm"],
    [Buffer.from("# Notes\nhello – world"), ".txt"],
  ])("detects %#", (head, ext) => {
    expect(detectExtension(head)).toBe(ext);
  });

  it("returns undefined for unknown binary data", () => {
    expect(detectExtension(bytes([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
  });
});

describe("stdinToTempFile", () => {
  it("writes all chunks to a private temp file named by the detected type", async () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");
    const file = await stdinToTempFile({ input: piped(png.subarray(0, 3), png.subarray(3)) });
    try {
      expect(path.basename(file.path)).toBe("stdin.png");
      expect(fs.readFileSync(file.path)).toEqual(png);
      expect(file.size).toBe(png.length);
    } finally {
      file.cleanup();
    }
    expect(fs.existsSync(path.dirname(file.path))).toBe(false);
  });

  it("honours an explicit extension", async () => {
    const file = await stdinToTempFile({ input: piped(Buffer.from("# hi")), ext: "md" });
    expect(path.basename(file.path)).toBe("stdin.md");
    file.cleanup();
  });

  it("falls back to .bin for unknown binary input", async () => {
    const file = await stdinToTempFile({ input: piped(bytes([0, 1, 2, 3])) });
    expect(path.extname(file.path)).toBe(".bin");
    file.cleanup();
  });

  it("rejects a terminal, empty input and unsafe extensions", async () => {
    const tty = Object.assign(piped(Buffer.from("x")), { isTTY: true });
    await expect(stdinToTempFile({ input: tty })).rejects.toBeInstanceOf(ValidationError);
    await expect(stdinToTempFile({ input: piped() })).rejects.toThrow(/stdin was empty/);
    await expect(
      stdinToTempFile({ input: piped(Buffer.from("x")), ext: "../../evil" }),
    ).rejects.toThrow(/Invalid --stdin-ext/);
  });

  it("removes the temp directory when reading fails", async () => {
    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("multix-stdin-")),
    );
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("pipe broke");
      })(),
    );
    await expect(stdinToTempFile({ input: failing })).rejects.toThrow("pipe broke");
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("multix-stdin-"));
    expect(after.filter((d) => !before.has(d))).toEqual([]);
  });
});

describe("resolveFileInputs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-files-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes regular files through and labels stdin", async () => {
    const real = path.join(dir, "a.txt");
    fs.writeFileSync(real, "a");
    const { inputs, cleanup } = await resolveFileInputs([real, "-"], {
      input: piped(Buffer.from("piped text")),
    });
    expect(inputs[0]).toEqual({ path: real, label: real });
    expect(inputs[1]?.label).toBe("stdin");
    expect(fs.readFileSync(inputs[1]?.path as string, "utf8")).toBe("piped text");
    cleanup();
    expect(fs.existsSync(inputs[1]?.path as string)).toBe(false);
    cleanup(); // idempotent
  });

  it("validates arguments before reading stdin", async () => {
    await expect(resolveFileInputs(["-", "-"])).rejects.toThrow(/only be passed once/);
    await expect(resolveFileInputs([path.join(dir, "missing.mp3"), "-"])).rejects.toThrow(
      /File not found/,
    );
    await expect(resolveFileInputs([path.join(dir)], { stdinExt: ".md" })).rejects.toThrow(
      /--stdin-ext only applies/,
    );
  });
});
