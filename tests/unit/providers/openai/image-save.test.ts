import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { saveOpenAIImages } from "../../../../src/providers/openai/openai-image.js";

describe("OpenAI image saving", () => {
  const originalEnv = { ...process.env };
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-openai-image-"));
    process.env.MULTIX_OUTPUT_DIR = tmp;
    _resetOutputDir();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetOutputDir();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes b64_json images", () => {
    const saved = saveOpenAIImages({
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
      task: "image",
      format: "png",
    });
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(saved[0] ?? "", "utf8")).toBe("png-bytes");
  });

  it("copies first image to output path", () => {
    const target = path.join(tmp, "out.webp");
    const saved = saveOpenAIImages({
      data: [{ b64_json: Buffer.from("webp-bytes").toString("base64") }],
      task: "image",
      format: "webp",
      output: target,
    });
    expect(saved[0]).not.toBe(target);
    expect(fs.readFileSync(target, "utf8")).toBe("webp-bytes");
  });

  it("rejects missing image data", () => {
    expect(() => saveOpenAIImages({ data: [{}], task: "image", format: "png" })).toThrow(
      /No b64_json/,
    );
  });
});
