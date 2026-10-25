import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  classifyError,
  classifyMessage,
  codeFromHttp,
} from "../../../src/core/error-classify.js";
import { ConfigError, HttpError, MultixError, ValidationError } from "../../../src/core/errors.js";

describe("codeFromHttp", () => {
  it("maps statuses to codes, refined by the body", () => {
    expect(codeFromHttp(401, "")).toBe("INVALID_KEY");
    expect(codeFromHttp(402, "")).toBe("QUOTA_EXCEEDED");
    expect(codeFromHttp(429, "Too many requests")).toBe("RATE_LIMITED");
    expect(codeFromHttp(429, "You exceeded your current quota")).toBe("QUOTA_EXCEEDED");
    expect(codeFromHttp(404, "model foo-1 not found")).toBe("MODEL_NOT_FOUND");
    expect(codeFromHttp(404, "")).toBe("NOT_FOUND");
    expect(codeFromHttp(400, "Request blocked by safety filters")).toBe("CONTENT_BLOCKED");
    expect(codeFromHttp(400, "bad thing")).toBe("PROVIDER_REJECTED");
    expect(codeFromHttp(503, "")).toBe("PROVIDER_UNAVAILABLE");
    expect(codeFromHttp(504, "")).toBe("TIMEOUT");
  });
});

describe("classifyMessage", () => {
  it("names the missing env key and exits with the config class", () => {
    const info = classifyMessage("RUNWAYML_API_SECRET is not set");
    expect(info).toMatchObject({
      code: "MISSING_KEY",
      env: "RUNWAYML_API_SECRET",
      retryable: false,
    });
    expect(info.exit_code).toBe(EXIT_CODES.config);
  });

  it("treats commander parse errors as usage errors", () => {
    expect(classifyMessage("error: unknown option '-p'").exit_code).toBe(EXIT_CODES.usage);
    expect(classifyMessage("error: missing required argument 'prompt'").exit_code).toBe(
      EXIT_CODES.usage,
    );
  });

  it("treats a rejected flag value as input, even for timeout flags", () => {
    expect(classifyMessage("Invalid --wait-timeout: abc").code).toBe("INVALID_INPUT");
  });

  it("reads an HTTP status out of a log line", () => {
    const info = classifyMessage("Failed: HTTP 429 rate limit");
    expect(info).toMatchObject({ code: "RATE_LIMITED", http_status: 429, retryable: true });
    expect(info.exit_code).toBe(EXIT_CODES.retryable);
  });

  it("falls back to UNKNOWN with a hint", () => {
    const info = classifyMessage("something odd");
    expect(info.code).toBe("UNKNOWN");
    expect(info.hint.length).toBeGreaterThan(0);
  });
});

describe("classifyError", () => {
  it("uses HttpError status and Retry-After", () => {
    const info = classifyError(
      new HttpError(429, "slow down", "https://api.example.com/v1/x", 2500),
    );
    expect(info).toMatchObject({ code: "RATE_LIMITED", http_status: 429, retry_after_s: 3 });
  });

  it("maps multix error classes", () => {
    expect(classifyError(new ValidationError("--num-images must be at most 4")).exit_code).toBe(
      EXIT_CODES.usage,
    );
    expect(classifyError(new ConfigError("GEMINI_API_KEY is not set")).exit_code).toBe(
      EXIT_CODES.config,
    );
  });
});

describe("pending and unknown-remote-state jobs", () => {
  it("classify as not retryable with the resume exit class", () => {
    for (const code of ["JOB_PENDING", "UNKNOWN_REMOTE_STATE"] as const) {
      const info = classifyError(new MultixError("job state", code));
      expect(info).toMatchObject({ code, retryable: false, exit_code: EXIT_CODES.timeout });
      expect(info.hint).toMatch(/resubmit|submitting again/);
    }
  });
});
