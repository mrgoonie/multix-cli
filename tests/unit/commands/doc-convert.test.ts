import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertDocuments } from "../../../src/commands/doc/convert.js";
import type { Logger } from "../../../src/core/logger.js";
import { _resetOutputDir } from "../../../src/core/output-dir.js";
import { _resetGeminiKeyCooldowns } from "../../../src/providers/gemini/key-pool.js";

const piped = (text: string) => Readable.from([Buffer.from(text)]);

const makeLogger = (): Logger & { error: ReturnType<typeof vi.fn> } => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  header: vi.fn(),
});

interface SeenRequest {
  url: string;
  body: { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> };
}

describe("convertDocuments with piped stdin", () => {
  let dir: string;
  let tmp: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-doc-test-"));
    // Private temp root so the stdin temp dir can be checked without racing other test files.
    tmp = path.join(dir, "tmp");
    fs.mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    vi.stubEnv("TEMP", tmp);
    vi.stubEnv("TMP", tmp);
    vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(dir, "out"));
    _resetOutputDir();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetOutputDir();
    _resetGeminiKeyCooldowns();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends piped text inline, labels it <stdin>, and removes the temp file", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-success");
    const seen: SeenRequest[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Converted" }] } }] }),
        { status: 200 },
      );
    });

    const output = path.join(dir, "result.md");
    await convertDocuments({
      inputs: ["-"],
      output,
      stdin: piped("piped notes"),
      logger: makeLogger(),
    });

    expect(seen).toHaveLength(1);
    const inline = seen[0]?.body.contents[0]?.parts[1]?.inlineData;
    expect(inline?.mimeType).toBe("text/plain");
    expect(Buffer.from(inline?.data ?? "", "base64").toString()).toBe("piped notes");

    const md = fs.readFileSync(output, "utf8");
    expect(md).toContain("## \\<stdin\\>");
    expect(md).toContain("# Converted");
    expect(md).not.toContain(tmp);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("names --auto-name output stdin-extraction.md", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-autoname");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
          status: 200,
        }),
    );

    await convertDocuments({ inputs: ["-"], autoName: true, stdin: piped("notes") });

    const expected = path.join(dir, "out", "stdin-extraction.md");
    expect(fs.existsSync(expected)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(`Output saved to: ${expected}`);
  });

  it("reports failures with the <stdin> label, exits 1, and still cleans up", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-failure");
    // 429 skips the per-file retry backoff, keeping the test fast.
    vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 429 }));
    const logger = makeLogger();

    const output = path.join(dir, "failed.md");
    await convertDocuments({ inputs: ["-"], output, stdin: piped("notes"), logger });

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^Failed: <stdin> — /));
    const md = fs.readFileSync(output, "utf8");
    expect(md).toContain("## \\<stdin\\>");
    expect(md).toContain("**Error**:");
    expect(md).not.toContain(tmp);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  describe("retry policy", () => {
    const ok = () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Ok" }] } }] }), {
        status: 200,
      });

    beforeEach(() => {
      // Only setTimeout is faked: a backoff sleep never resolves unless the test advances the
      // clock, so a run that completes without advancing proves no retry delay was taken.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails a missing key immediately without sleeping or calling the API", async () => {
      vi.stubEnv("GEMINI_API_KEY", "");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const logger = makeLogger();

      await convertDocuments({
        inputs: ["-"],
        output: path.join(dir, "no-key.md"),
        stdin: piped("notes"),
        logger,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("GEMINI_API_KEY is not set"),
      );
      expect(logger.debug).not.toHaveBeenCalledWith(expect.stringMatching(/^Retry /));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    for (const status of [400, 401, 403, 404]) {
      it(`does not retry HTTP ${status}`, async () => {
        vi.stubEnv("GEMINI_API_KEY", `test-key-${status}`);
        const fetchSpy = vi.fn(async () => new Response("bad request", { status }));
        vi.stubGlobal("fetch", fetchSpy);
        const logger = makeLogger();

        await convertDocuments({
          inputs: ["-"],
          output: path.join(dir, `http-${status}.md`),
          stdin: piped("notes"),
          logger,
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(logger.debug).not.toHaveBeenCalledWith(expect.stringMatching(/^Retry /));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`));
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    }

    it("retries HTTP 503 with backoff and succeeds", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-503");
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetchSpy);
      const logger = makeLogger();
      const output = path.join(dir, "retry-503.md");

      const run = convertDocuments({ inputs: ["-"], output, stdin: piped("notes"), logger });
      await vi.runAllTimersAsync();
      await run;

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/^Retry 1 after 1s: /));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/^Retry 2 after 2s: /));
      expect(fs.readFileSync(output, "utf8")).toContain("# Ok");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("retries network failures", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-network");
      const fetchSpy = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetchSpy);
      const output = path.join(dir, "retry-network.md");

      const run = convertDocuments({ inputs: ["-"], output, stdin: piped("notes") });
      await vi.runAllTimersAsync();
      await run;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(output, "utf8")).toContain("# Ok");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("rotates to the next key on 429 without a backoff sleep", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-limited");
      vi.stubEnv("GEMINI_API_KEY_2", "test-key-spare");
      const keys: string[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const key = (init.headers as Record<string, string>)["x-goog-api-key"] ?? "";
        keys.push(key);
        return key === "test-key-limited" ? new Response("quota", { status: 429 }) : ok();
      });
      const output = path.join(dir, "rotate.md");

      await convertDocuments({ inputs: ["-"], output, stdin: piped("notes") });

      expect(keys).toEqual(["test-key-limited", "test-key-spare"]);
      expect(fs.readFileSync(output, "utf8")).toContain("# Ok");
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it("rejects a missing real file before reading stdin or creating the output dir", async () => {
    const stdin = piped("never read");
    const read = vi.spyOn(stdin, Symbol.asyncIterator);
    await expect(
      convertDocuments({ inputs: [path.join(dir, "missing.pdf"), "-"], stdin }),
    ).rejects.toThrow(/^File not found: /);
    expect(read).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
  });

  it("suggests a document --stdin-ext when the piped type is unknown, leaving no output dir", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      convertDocuments({ inputs: ["-"], stdin: Readable.from([Buffer.from([0, 1, 2, 3])]) }),
    ).rejects.toThrow("--stdin-ext pdf");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
  });

  it("applies --stdin-ext to undetectable piped input", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key-stdin-ext");
    const seen: SeenRequest[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200 },
      );
    });

    const output = path.join(dir, "ext.md");
    await convertDocuments({
      inputs: ["-"],
      output,
      stdinExt: "pdf",
      stdin: Readable.from([Buffer.from([0, 1, 2, 3])]),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.contents[0]?.parts[1]?.inlineData?.mimeType).toBe("application/pdf");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  describe("stdin larger than 20 MB (Files API)", () => {
    const big = () => Readable.from([Buffer.alloc(21 * 1024 * 1024, "a")]);

    it("uploads as stdin.<ext> without exposing the temp path", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-upload");
      let uploadBody = "";
      const generateBodies: SeenRequest["body"][] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url.includes("/upload/")) {
          // Only the multipart metadata matters; skip the 21 MB payload.
          uploadBody = (init.body as Buffer).subarray(0, 512).toString("latin1");
          return new Response(
            JSON.stringify({
              file: {
                name: "files/abc",
                uri: "https://files.example/abc",
                mimeType: "text/plain",
                state: "ACTIVE",
              },
            }),
            { status: 200 },
          );
        }
        generateBodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Big" }] } }] }),
          { status: 200 },
        );
      });

      const output = path.join(dir, "big.md");
      await convertDocuments({ inputs: ["-"], output, stdin: big() });

      expect(uploadBody).toContain('"displayName":"stdin.txt"');
      expect(uploadBody).not.toContain(tmp);
      const parts = generateBodies[0]?.contents[0]?.parts as Array<Record<string, unknown>>;
      expect(parts?.[1]).toEqual({
        fileData: { mimeType: "text/plain", fileUri: "https://files.example/abc" },
      });
      const md = fs.readFileSync(output, "utf8");
      expect(md).toContain("# Big");
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it("retries an upload that fails at the network layer", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-upload-network");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      let uploads = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/upload/")) {
          uploads++;
          if (uploads === 1) throw new TypeError("fetch failed");
          return new Response(
            JSON.stringify({
              file: { name: "files/n", uri: "https://files.example/n", mimeType: "text/plain" },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Up" }] } }] }),
          { status: 200 },
        );
      });

      const output = path.join(dir, "upload-retry.md");
      try {
        const run = convertDocuments({ inputs: ["-"], output, stdin: big() });
        await vi.runAllTimersAsync();
        await run;
      } finally {
        vi.useRealTimers();
      }

      expect(uploads).toBe(2);
      expect(fs.readFileSync(output, "utf8")).toContain("# Up");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("labels upload failures <stdin> and cleans up", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-upload-fail");
      // 429 skips the per-file retry backoff, keeping the test fast.
      vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 429 }));
      const logger = makeLogger();

      const output = path.join(dir, "big-failed.md");
      await convertDocuments({ inputs: ["-"], output, stdin: big(), logger });

      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^Failed: <stdin> — /));
      const md = fs.readFileSync(output, "utf8");
      expect(md).toContain("**Error**:");
      expect(md).not.toContain(tmp);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });
});
