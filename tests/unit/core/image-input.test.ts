/**
 * Tests for resolveImageInput — URL passthrough vs base64 encoding.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveImageInput } from "../../../src/core/image-input.js";

const TMP_DIR = path.join(os.tmpdir(), `byteplus-test-${Date.now()}`);

describe("resolveImageInput", () => {
  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    await fs.writeFile(path.join(TMP_DIR, "tiny.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    await fs.writeFile(path.join(TMP_DIR, "weird.xyz"), Buffer.from("data"));
  });

  afterAll(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("passes http(s) URLs through unchanged", async () => {
    const r = await resolveImageInput("https://example.com/image.jpg");
    expect(r).toEqual({ kind: "url", url: "https://example.com/image.jpg" });
  });

  it("base64-encodes a local jpg file", async () => {
    const r = await resolveImageInput(path.join(TMP_DIR, "tiny.jpg"));
    expect(r.kind).toBe("data");
    if (r.kind === "data") {
      expect(r.mime).toBe("image/jpeg");
      expect(r.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(r.bytes).toBe(3);
    }
  });

  it("rejects unsupported extensions", async () => {
    await expect(resolveImageInput(path.join(TMP_DIR, "weird.xyz"))).rejects.toThrow(
      /Unsupported image extension/,
    );
  });

  it("rejects missing files", async () => {
    await expect(resolveImageInput(path.join(TMP_DIR, "nope.jpg"))).rejects.toThrow();
  });
});
