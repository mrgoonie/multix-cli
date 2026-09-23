import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readImageHeaderFromFile } from "../../../src/core/image-header.js";
import {
  finalizeGeneratedImages,
  hasCwebp,
  resolveImageFormatMode,
} from "../../../src/core/image-webp-finalize.js";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Build a width x height RGBA PNG with a half-transparent left side. */
function rgbaPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) row.set([200, 40, 90, x < width / 2 ? 0 : 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("resolveImageFormatMode", () => {
  const saved = process.env.MULTIX_IMAGE_FORMAT;
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "MULTIX_IMAGE_FORMAT");
  });
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "MULTIX_IMAGE_FORMAT");
    else process.env.MULTIX_IMAGE_FORMAT = saved;
  });

  it("defaults to webp", () => expect(resolveImageFormatMode({})).toBe("webp"));
  it("opts out via --no-webp", () =>
    expect(resolveImageFormatMode({ webp: false })).toBe("original"));
  it("opts out via --image-format original", () =>
    expect(resolveImageFormatMode({ imageFormat: "original" })).toBe("original"));
  it("opts out via env", () => {
    process.env.MULTIX_IMAGE_FORMAT = "original";
    expect(resolveImageFormatMode({})).toBe("original");
  });
  it("honors a non-webp --output extension", () =>
    expect(resolveImageFormatMode({ output: "out/a.png" })).toBe("original"));
  it("keeps webp for a .webp --output", () =>
    expect(resolveImageFormatMode({ output: "out/a.webp" })).toBe("webp"));
  it("honors an explicit provider format flag", () =>
    expect(resolveImageFormatMode({}, true)).toBe("original"));
  it("rejects unknown modes", () =>
    expect(() => resolveImageFormatMode({ imageFormat: "gif" })).toThrow(/Invalid --image-format/));
});

describe.skipIf(!hasCwebp())("finalizeGeneratedImages", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-webp-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("converts to webp, keeps size and alpha, removes the intermediate", () => {
    const src = path.join(dir, "gen.png");
    fs.writeFileSync(src, rgbaPng(37, 21));
    const [out] = finalizeGeneratedImages([src], {});
    expect(out).toBe(path.join(dir, "gen.webp"));
    expect(fs.existsSync(src)).toBe(false);
    expect(readImageHeaderFromFile(out as string)).toMatchObject({
      kind: "webp",
      width: 37,
      height: 21,
      hasAlpha: true,
    });
  });

  it("refreshes a copied .webp --output with converted bytes", () => {
    const src = path.join(dir, "gen.png");
    const output = path.join(dir, "final.webp");
    fs.writeFileSync(src, rgbaPng(8, 8));
    fs.copyFileSync(src, output);
    finalizeGeneratedImages([src], { output });
    expect(readImageHeaderFromFile(output)?.kind).toBe("webp");
  });

  it("leaves files untouched in original mode", () => {
    const src = path.join(dir, "gen.png");
    fs.writeFileSync(src, rgbaPng(4, 4));
    expect(finalizeGeneratedImages([src], { imageFormat: "original" })).toEqual([src]);
    expect(fs.existsSync(src)).toBe(true);
  });
});
