import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok } from "../../../src/core/result.js";

describe("result helpers", () => {
  it("ok() creates success result", () => {
    const r = ok({ value: 42 });
    expect(r.status).toBe("success");
    expect(r.value).toBe(42);
  });

  it("err() creates error result", () => {
    const r = err("something broke");
    expect(r.status).toBe("error");
    expect(r.error).toBe("something broke");
  });

  it("isOk() returns true for success result", () => {
    expect(isOk(ok({ x: 1 }))).toBe(true);
  });

  it("isOk() returns false for error result", () => {
    expect(isOk(err("oops"))).toBe(false);
  });

  it("isErr() returns true for error result", () => {
    expect(isErr(err("bad"))).toBe(true);
  });

  it("isErr() returns false for success result", () => {
    expect(isErr(ok({ done: true }))).toBe(false);
  });

  it("ok() merges multiple fields", () => {
    const r = ok({ a: 1, b: "hello", c: true });
    expect(r.status).toBe("success");
    expect(r.a).toBe(1);
    expect(r.b).toBe("hello");
    expect(r.c).toBe(true);
  });
});
