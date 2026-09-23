/**
 * Minimal image header reader for PNG, JPEG, and WebP.
 * Reports format, dimensions, and whether the image carries an alpha channel,
 * so converted images can be verified against their source before delivery.
 */

import fs from "node:fs";

export type ImageKind = "png" | "jpeg" | "webp";

export interface ImageHeader {
  kind: ImageKind;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Detect image kind from magic bytes; undefined when not PNG/JPEG/WebP. */
export function sniffImageKind(buf: Buffer): ImageKind | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return undefined;
}

function readPng(buf: Buffer): ImageHeader | undefined {
  if (buf.length < 33) return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf[25];
  // Color types 4 (gray+alpha) and 6 (RGBA) carry alpha; a tRNS chunk adds it to others.
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8;
  while (!hasAlpha && offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") hasAlpha = true;
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + len;
  }
  return { kind: "png", width, height, hasAlpha };
}

function readJpeg(buf: Buffer): ImageHeader | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1] ?? 0;
    // SOF0..SOF15 excluding DHT (C4), JPG (C8), DAC (CC) hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        kind: "jpeg",
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
        hasAlpha: false,
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return undefined;
}

function readWebp(buf: Buffer): ImageHeader | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const flags = buf[20] ?? 0;
    return {
      kind: "webp",
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      hasAlpha: (flags & 0x10) !== 0,
    };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return {
      kind: "webp",
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
      hasAlpha: ((bits >>> 28) & 1) === 1,
    };
  }
  if (chunk === "VP8 ") {
    return {
      kind: "webp",
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      hasAlpha: false,
    };
  }
  return undefined;
}

/** Parse an image buffer header; undefined when unsupported or malformed. */
export function readImageHeader(buf: Buffer): ImageHeader | undefined {
  const kind = sniffImageKind(buf);
  if (kind === "png") return readPng(buf);
  if (kind === "jpeg") return readJpeg(buf);
  if (kind === "webp") return readWebp(buf);
  return undefined;
}

export function readImageHeaderFromFile(file: string): ImageHeader | undefined {
  return readImageHeader(fs.readFileSync(file));
}
