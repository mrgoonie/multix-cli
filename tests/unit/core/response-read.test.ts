import { describe, expect, it } from "vitest";
import { ResponseTooLargeError } from "../../../src/core/errors.js";
import {
  NOT_SENT_CODES,
  concatBytes,
  errorCodes,
  readCappedBytes,
  readCappedText,
} from "../../../src/core/response-read.js";

function streamOf(chunks: Uint8Array[], opts: { hang?: boolean } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++] as Uint8Array);
      else if (!opts.hang) controller.close();
    },
  });
}

describe("readCappedBytes", () => {
  it("joins the chunks of a body under the cap", async () => {
    const res = new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
    expect(Array.from(await readCappedBytes(res, 10, 1000, "https://x.test/a"))).toEqual([1, 2, 3]);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    const body = new ReadableStream({
      pull() {
        throw new Error("body was read");
      },
    });
    const res = new Response(body, { headers: { "content-length": "20" } });
    await expect(readCappedBytes(res, 10, 1000, "https://x.test/a")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("accepts a body of exactly the cap", async () => {
    const res = new Response(streamOf([new Uint8Array(4), new Uint8Array(6)]), {
      headers: { "content-length": "10" },
    });
    expect((await readCappedBytes(res, 10, 1000, "https://x.test/a")).length).toBe(10);
  });

  it("stops once the streamed bytes pass the cap", async () => {
    const res = new Response(streamOf([new Uint8Array(6), new Uint8Array(6)]));
    await expect(readCappedBytes(res, 10, 1000, "https://x.test/a")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("fails when no bytes arrive within the idle timeout", async () => {
    const res = new Response(streamOf([new Uint8Array([1])], { hang: true }));
    await expect(readCappedBytes(res, 10, 20, "https://x.test/a")).rejects.toThrow(
      /no audio bytes/,
    );
  });

  it("returns no bytes for a response without a body", async () => {
    expect((await readCappedBytes(new Response(null), 10, 1000, "https://x.test/a")).length).toBe(
      0,
    );
  });
});

describe("readCappedText", () => {
  it("returns at most the limit", async () => {
    const res = new Response(streamOf([new TextEncoder().encode("abcdef")]));
    expect(await readCappedText(res, 3)).toBe("abc");
  });

  it("returns an empty string for a response without a body", async () => {
    expect(await readCappedText(new Response(null), 10)).toBe("");
  });

  it("says so when the body cannot be read", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    expect(await readCappedText(new Response(body), 10)).toBe("(could not read body)");
  });
});

describe("concatBytes", () => {
  it("truncates to the given size", () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3, 4])], 3);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});

describe("errorCodes", () => {
  it("collects codes from nested causes and aggregate errors", () => {
    const err = {
      code: "UND_ERR",
      cause: {
        errors: [{ code: "ECONNREFUSED" }, null, { code: 1 }],
        cause: { code: "ENOTFOUND" },
      },
    };
    expect(errorCodes(err)).toEqual(["UND_ERR", "ECONNREFUSED", "ENOTFOUND"]);
    expect(errorCodes(err).some((c) => NOT_SENT_CODES.has(c))).toBe(true);
    expect(errorCodes("boom")).toEqual([]);
  });

  it("stops after four levels of causes", () => {
    const err = {
      code: "A",
      cause: { code: "B", cause: { code: "C", cause: { code: "D", cause: { code: "E" } } } },
    };
    expect(errorCodes(err)).toEqual(["A", "B", "C", "D"]);
  });
});
