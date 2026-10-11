import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  MAX_STDIN_BYTES,
  detectExtension,
  labelError,
  resolveFileInputs,
  stdinToTempFile,
  stdinTooLargeMessage,
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
    [bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84], "webm"), ".webm"],
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
    expect(inputs[1]?.label).toBe("<stdin>");
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

  it("uses the caller's flag and example in messages", async () => {
    const usage = { flag: "--input", example: "cat report.pdf | multix doc convert --input -" };
    await expect(resolveFileInputs(["-", "-"], usage)).rejects.toThrow(
      "`-` (stdin) can only be passed once to --input",
    );
    await expect(resolveFileInputs([], { ...usage, stdinExt: "pdf" })).rejects.toThrow(
      "--stdin-ext only applies when --input includes `-`",
    );
    const tty = Object.assign(piped(Buffer.from("x")), { isTTY: true });
    await expect(resolveFileInputs(["-"], { ...usage, input: tty })).rejects.toThrow(
      "`--input -` reads piped input, but stdin is a terminal. Example: cat report.pdf | multix doc convert --input -",
    );
    await expect(resolveFileInputs(["-"], { ...usage, input: piped() })).rejects.toThrow(
      "`--input -` was given but stdin was empty",
    );
  });

  describe("review hardening", () => {
    const pipe = (...chunks: Buffer[]) =>
      Object.assign(
        (async function* () {
          for (const c of chunks) yield c;
        })(),
        { isTTY: false },
      );

    it("does not mistake HEIC or AVIF images for mp4", () => {
      const ftyp = (brand: string) =>
        Buffer.concat([
          Buffer.from([0, 0, 0, 0x18]),
          Buffer.from(`ftyp${brand}`, "latin1"),
          Buffer.alloc(8),
        ]);
      expect(detectExtension(ftyp("heic"))).toBe(".heic");
      expect(detectExtension(ftyp("mif1"))).toBe(".heic");
      expect(detectExtension(ftyp("avif"))).toBeUndefined();
      expect(detectExtension(ftyp("isom"))).toBe(".mp4");
    });

    it("does not mistake UTF-16 text or text starting with ID3 for mp3", () => {
      expect(detectExtension(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBeUndefined();
      expect(detectExtension(Buffer.from("ID3 tags explained"))).toBe(".txt");
      expect(detectExtension(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]))).toBe(".mp3");
      expect(detectExtension(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe(".txt");
    });

    it("treats control bytes as binary and plain Matroska as unknown", () => {
      expect(detectExtension(Buffer.from([0x01, 0x02, 0x41, 0x42]))).toBeUndefined();
      const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82]);
      expect(detectExtension(Buffer.concat([ebml, Buffer.from("matroska")]))).toBeUndefined();
      expect(detectExtension(Buffer.concat([ebml, Buffer.from("webm")]))).toBe(".webm");
    });

    it("rejects undetectable stdin unless --stdin-ext is given", async () => {
      const bin = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await expect(resolveFileInputs(["-"], { input: pipe(bin) })).rejects.toThrow(/--stdin-ext/);
      const ok = await resolveFileInputs(["-"], { input: pipe(bin), stdinExt: "mp3" });
      expect(path.extname(ok.inputs[0]?.path ?? "")).toBe(".mp3");
      ok.cleanup();
    });

    it("stops reading past the size limit and removes the temp dir", async () => {
      const before = fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("multix-stdin-")).length;
      await expect(
        resolveFileInputs(["-"], {
          input: pipe(Buffer.alloc(10, 0x61), Buffer.alloc(10, 0x61)),
          maxBytes: 15,
        }),
      ).rejects.toThrow("Piped stdin exceeds the 15-byte limit");
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("multix-stdin-")).length;
      expect(after).toBeLessThanOrEqual(before);
    });

    it("names the 2 GB Files API limit for the default cap, as the docs do", () => {
      expect(MAX_STDIN_BYTES).toBe(2_000_000_000);
      const msg = stdinTooLargeMessage(MAX_STDIN_BYTES);
      expect(msg).toBe(
        "Piped stdin exceeds the Gemini Files API limit of 2 GB (2,000,000,000 bytes)",
      );
      expect(msg).not.toMatch(/save it to a file/);
    });

    it("registers signal cleanup while the file exists and unregisters it after", async () => {
      const base = process.listenerCount("SIGTERM");
      const { cleanup, inputs } = await resolveFileInputs(["-"], {
        input: pipe(Buffer.from("hello")),
      });
      expect(process.listenerCount("SIGTERM")).toBe(base + 1);
      const tmpPath = inputs[0]?.path ?? "";
      expect(fs.existsSync(tmpPath)).toBe(true);
      cleanup();
      cleanup();
      expect(fs.existsSync(tmpPath)).toBe(false);
      expect(process.listenerCount("SIGTERM")).toBe(base);
    });

    it("replaces the temp path with the label in error messages", () => {
      const input = { path: "/tmp/multix-stdin-x/stdin.mp4", label: "<stdin>" };
      expect(labelError(`File processing failed: ${input.path}`, input)).toBe(
        "File processing failed: <stdin>",
      );
      expect(labelError("boom a.mp4", { path: "a.mp4", label: "a.mp4" })).toBe("boom a.mp4");
    });
  });
});
