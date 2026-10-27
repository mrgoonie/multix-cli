import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as audioKind from "../../../src/core/audio-kind.js";
import { ResponseTooLargeError } from "../../../src/core/errors.js";
import * as httpBody from "../../../src/core/http-body.js";
import * as speechAudio from "../../../src/providers/openrouter/speech-audio.js";
import * as speechClient from "../../../src/providers/openrouter/speech-client.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("http-body", () => {
  it("readCappedText stops at the byte limit", async () => {
    const response = new Response(
      streamOf([new TextEncoder().encode("abcdef"), new Uint8Array(4)]),
    );
    expect(await httpBody.readCappedText(response, 4)).toBe("abcd");
  });

  it("readAudio concatenates chunks and refuses bodies past the cap", async () => {
    const ok = new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
    expect([...(await httpBody.readAudio(ok, 3, 1000, "https://x.test"))]).toEqual([1, 2, 3]);
    const big = new Response(streamOf([new Uint8Array(4)]));
    await expect(httpBody.readAudio(big, 3, 1000, "https://x.test")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("readAudio fails a body that stalls past the idle timeout", async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    await expect(httpBody.readAudio(stalled, 10, 20, "https://x.test")).rejects.toThrow(
      /no audio bytes/,
    );
  });

  it("errorCodes walks causes and aggregate errors", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("agg"), { errors: [{ code: "ECONNREFUSED" }] }),
    });
    const codes = httpBody.errorCodes(err);
    expect(codes).toEqual(["ECONNREFUSED"]);
    expect(codes.some((c) => httpBody.NOT_SENT_CODES.has(c))).toBe(true);
  });
});

describe("OpenRouter re-exports of the shared helpers", () => {
  it("are the core implementations, so existing imports keep working", () => {
    expect(speechClient.readCappedText).toBe(httpBody.readCappedText);
    expect(speechClient.readAudio).toBe(httpBody.readAudio);
    expect(speechClient.errorCodes).toBe(httpBody.errorCodes);
    expect(speechClient.NOT_SENT_CODES).toBe(httpBody.NOT_SENT_CODES);
    expect(speechClient.UNKNOWN_REMOTE_STATE).toBe(httpBody.UNKNOWN_REMOTE_STATE);
    expect(speechAudio.parseAudioContentType).toBe(audioKind.parseAudioContentType);
    expect(speechAudio.looksLikeMp3).toBe(audioKind.looksLikeMp3);
  });
});

describe("provider isolation", () => {
  it("no provider other than OpenRouter imports from providers/openrouter", () => {
    const root = path.resolve("src/providers");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const src = fs.readFileSync(full, "utf8");
          if (/from\s+["'][^"']*\/openrouter\//.test(src))
            offenders.push(path.relative(root, full));
        }
      }
    };
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "openrouter") walk(path.join(root, entry.name));
    }
    expect(offenders).toEqual([]);
  });
});
