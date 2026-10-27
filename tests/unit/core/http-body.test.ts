import { describe, expect, it } from "vitest";
import { ResponseTooLargeError } from "../../../src/core/errors.js";
import {
  NOT_SENT_CODES,
  errorCodes,
  readAudio,
  readCappedText,
} from "../../../src/core/http-body.js";

function streamOf(chunks: Uint8Array[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else if (!opts.hang) controller.close();
    },
  });
}

describe("readAudio", () => {
  it("joins the chunks of a body under the cap", async () => {
    const res = new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
    expect(Array.from(await readAudio(res, 10, 1000, "https://x.test/a"))).toEqual([1, 2, 3]);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    const res = new Response(new Uint8Array(20), { headers: { "content-length": "20" } });
    await expect(readAudio(res, 10, 1000, "https://x.test/a")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("stops once the streamed bytes pass the cap", async () => {
    const res = new Response(streamOf([new Uint8Array(6), new Uint8Array(6)]));
    await expect(readAudio(res, 10, 1000, "https://x.test/a")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("fails when no bytes arrive within the idle timeout", async () => {
    const res = new Response(streamOf([new Uint8Array([1])], { hang: true }));
    await expect(readAudio(res, 10, 20, "https://x.test/a")).rejects.toThrow(/no audio bytes/);
  });
});

describe("readCappedText", () => {
  it("returns at most the limit", async () => {
    const res = new Response(streamOf([new TextEncoder().encode("abcdef")]));
    expect(await readCappedText(res, 3)).toBe("abc");
  });
});

describe("errorCodes", () => {
  it("collects codes from nested causes and aggregate errors", () => {
    const err = {
      code: "UND_ERR",
      cause: { errors: [{ code: "ECONNREFUSED" }, { code: 1 }], cause: { code: "ENOTFOUND" } },
    };
    expect(errorCodes(err)).toEqual(["UND_ERR", "ECONNREFUSED", "ENOTFOUND"]);
    expect(errorCodes(err).some((c) => NOT_SENT_CODES.has(c))).toBe(true);
    expect(errorCodes("boom")).toEqual([]);
  });
});
