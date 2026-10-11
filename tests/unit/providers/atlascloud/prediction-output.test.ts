import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyOutputs,
  collectOutputs,
  hasNsfwFlag,
  isFailureStatus,
  isSuccessStatus,
  isTerminalStatus,
  outputCategory,
  outputExtension,
  outputFileName,
  predictionErrorMessage,
} from "../../../../src/providers/atlascloud/prediction-output.js";
import { guessUploadMimeType } from "../../../../src/providers/atlascloud/upload-mime.js";

describe("status helpers", () => {
  it("treats documented and schema-listed statuses correctly", () => {
    for (const s of ["completed", "succeeded", "COMPLETED"]) expect(isSuccessStatus(s)).toBe(true);
    for (const s of ["failed", "error", "timeout", "cancelled"])
      expect(isFailureStatus(s)).toBe(true);
    for (const s of ["processing", "queued", "", undefined])
      expect(isTerminalStatus(s)).toBe(false);
  });

  it("collapses string, object and empty errors", () => {
    expect(predictionErrorMessage("")).toBe("");
    expect(predictionErrorMessage(" boom ")).toBe("boom");
    expect(predictionErrorMessage({ message: "bad size" })).toBe("bad size");
    expect(predictionErrorMessage({ code: 7 })).toBe('{"code":7}');
  });
});

describe("collectOutputs / classifyOutputs", () => {
  it("normalizes outputs, output and object entries", () => {
    expect(collectOutputs({ id: "a", status: "completed", outputs: null })).toEqual([]);
    expect(collectOutputs({ id: "a", status: "completed", output: "https://x/a.png" })).toEqual([
      "https://x/a.png",
    ]);
    expect(
      collectOutputs({
        id: "a",
        status: "completed",
        outputs: [{ url: "https://x/b.mp4" }, "", 3],
      }),
    ).toEqual(["https://x/b.mp4"]);
  });

  it("keeps speech-to-text transcripts as text, never as downloads", () => {
    const c = classifyOutputs({
      id: "a",
      status: "completed",
      outputs: ["Thanks for joining the call today"],
    });
    expect(c).toEqual({ mode: "text", texts: ["Thanks for joining the call today"] });
  });

  it("splits media from text when both are present", () => {
    const c = classifyOutputs({
      id: "a",
      status: "completed",
      outputs: ["https://x/1.mp3", "https://x/2.mp3", "lyrics text"],
    });
    expect(c).toEqual({
      mode: "media",
      urls: ["https://x/1.mp3", "https://x/2.mp3"],
      texts: ["lyrics text"],
    });
    expect(classifyOutputs({ id: "a", status: "completed", outputs: [] })).toEqual({
      mode: "empty",
    });
  });

  it("detects NSFW blocks", () => {
    expect(hasNsfwFlag({ id: "a", status: "completed", has_nsfw_contents: [false, true] })).toBe(
      true,
    );
    expect(hasNsfwFlag({ id: "a", status: "completed", has_nsfw_contents: null })).toBe(false);
  });
});

describe("extensions and names", () => {
  it("normalizes extensions from URLs and data URIs", () => {
    expect(outputExtension("https://cdn/x/abc.JPEG?sig=1")).toBe("jpg");
    expect(outputExtension("https://cdn/x/model.glb")).toBe("glb");
    expect(outputExtension("https://cdn/x/noext")).toBeUndefined();
    expect(outputExtension("data:image/png;base64,AAAA")).toBe("png");
    expect(outputCategory("https://cdn/x/a.mp4")).toBe("video");
    expect(outputCategory("https://cdn/x/a.wav")).toBe("audio");
    expect(outputCategory("https://cdn/x/a.zip")).toBe("3d");
  });

  it("names multi-output files atlas-<idprefix>-NN.<ext>", () => {
    expect(outputFileName("47e7acf05d7449c1874f", 0, "jpg")).toBe("atlas-47e7acf0-01.jpg");
    expect(outputFileName("ab", 11, "mp3")).toBe("atlas-ab-12.mp3");
  });

  it("guesses upload content types by extension", () => {
    expect(guessUploadMimeType("Photo.JPG")).toBe("image/jpeg");
    expect(guessUploadMimeType("clip.mov")).toBe("video/quicktime");
    expect(guessUploadMimeType("voice.m4a")).toBe("audio/mp4");
    expect(guessUploadMimeType("blob")).toBe("application/octet-stream");
  });
});

describe("runtime neutrality", () => {
  // These modules are shared with a Cloudflare Worker: no node:* imports and
  // no Node-only core helpers (env loading, fs downloads, terminal logger).
  const NEUTRAL = [
    "client.ts",
    "types.ts",
    "models.ts",
    "model-input.ts",
    "prediction-output.ts",
    "upload-mime.ts",
  ];
  const FORBIDDEN =
    /from\s+["'](node:[^"']+|[^"']*\/(env-loader|http-client|logger|output-dir|json-input|image-input)\.js)["']/;
  const WORKER_SAFE_CORE = new Set([
    "errors.js",
    "fetch-error.js",
    "fetch-json.js",
    "async-poll.js",
    "redact.js",
    "redirect-fetch.js",
  ]);

  it.each(NEUTRAL)("%s has no node:* or Node-only imports", (file) => {
    const src = fs.readFileSync(path.resolve("src/providers/atlascloud", file), "utf8");
    expect(src).not.toMatch(FORBIDDEN);
    for (const m of src.matchAll(/from\s+["']\.\.\/\.\.\/core\/([^"']+)["']/g)) {
      expect(WORKER_SAFE_CORE.has(m[1] as string)).toBe(true);
    }
  });
});
