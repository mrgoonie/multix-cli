import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  classifyError,
  classifyMessage,
  classifySignalExit,
  codeFromHttp,
} from "../../../src/core/error-classify.js";
import {
  ConfigError,
  HttpError,
  MissingBinaryError,
  ProviderError,
  ValidationError,
} from "../../../src/core/errors.js";

describe("TopView payment_required", () => {
  it("reads a prediction that needs payment as out of credits, not bad input", () => {
    const message =
      "TopView prediction p_1 needs payment (payment_required). Amount due: $1.2. Top up the same API Platform workspace at https://platform.topview.ai; settlement retries automatically without resubmitting. Then resume with: multix topview prediction p_1 --wait --download";
    expect(classifyMessage(message).code).toBe("QUOTA_EXCEEDED");
    expect(classifyError(new ProviderError(message, "topview")).code).toBe("QUOTA_EXCEEDED");
  });
});

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

  it("redacts URL query strings in the message it hands to the envelope and ledger", () => {
    const info = classifyError(
      new ProviderError(
        "OpenRouter returned no transcript text: could not fetch https://cdn.example.com/a.wav?sig=SECRETSIG",
        "openrouter",
      ),
    );
    expect(info.message).toBe(
      "OpenRouter returned no transcript text: could not fetch https://cdn.example.com/a.wav?[redacted]",
    );
    expect(classifyMessage("HTTP 400: bad https://x.test/a?token=SECRET2").message).not.toContain(
      "SECRET2",
    );
  });

  it("maps multix error classes", () => {
    expect(classifyError(new ValidationError("--num-images must be at most 4")).exit_code).toBe(
      EXIT_CODES.usage,
    );
    expect(classifyError(new ConfigError("GEMINI_API_KEY is not set")).exit_code).toBe(
      EXIT_CODES.config,
    );
  });

  it("reports a missing ffmpeg or ffprobe as a binary to install, not bad input", () => {
    const info = classifyError(
      new MissingBinaryError("ffprobe not found on PATH — install ffmpeg which bundles ffprobe"),
    );
    expect(info.code).toBe("BINARY_MISSING");
    expect(info.exit_code).toBe(EXIT_CODES.config);
    // A user's file name that mentions ffmpeg is still bad input, not a missing binary.
    expect(
      classifyError(new ValidationError("Profile file not found: ffmpeg-missing.json")).code,
    ).toBe("INVALID_INPUT");
  });

  it("reports a signal's exit status as CANCELLED and keeps that status", () => {
    for (const [status, signal] of [
      [129, "SIGHUP"],
      [130, "SIGINT"],
      [143, "SIGTERM"],
    ] as const) {
      expect(classifySignalExit(status)).toMatchObject({
        code: "CANCELLED",
        message: `Cancelled by ${signal} (exit ${status})`,
        retryable: false,
        hint: "The run was cancelled; nothing was left behind. Rerun the command.",
        exit_code: status,
      });
    }
    const sent = classifySignalExit(143, true);
    expect(sent).toMatchObject({ code: "CANCELLED", exit_code: 143 });
    expect(sent?.hint).toMatch(/pay twice/);
    for (const status of [0, 1, 2, 6, 128, 131, 137]) {
      expect(classifySignalExit(status)).toBeUndefined();
    }
  });
});
