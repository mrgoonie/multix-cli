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
  ProviderJobFailedError,
  ValidationError,
} from "../../../src/core/errors.js";
import { AtlasPredictionFailedError } from "../../../src/providers/atlascloud/client.js";
import { HeygenJobFailedError } from "../../../src/providers/heygen/heygen-errors.js";
import { ReplicatePredictionError } from "../../../src/providers/replicate/client.js";
import { RunwayTaskError } from "../../../src/providers/runway/client.js";
import { SumeJobError } from "../../../src/providers/sume/client.js";
import { TopviewPredictionError, TopviewTaskError } from "../../../src/providers/topview/errors.js";

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

  it("reports a job the provider ended as JOB_FAILED, whatever its message says", () => {
    const failures = [
      new ReplicatePredictionError({
        id: "p1x9",
        status: "failed",
        error: "out of memory",
      } as never),
      new AtlasPredictionFailedError({ id: "a1", status: "failed", error: "bad input" } as never),
      new RunwayTaskError({ id: "t-1", status: "FAILED", failureCode: "INTERNAL" } as never),
      new SumeJobError("j1", "failed"),
      new TopviewTaskError({ kind: "avatar", taskId: "t9", status: "fail" } as never),
      new TopviewPredictionError({ id: "tp1", status: "failed", outputs: [] } as never),
      new HeygenJobFailedError('HeyGen video v1 ended with status "failed"', "render_error"),
      new ProviderJobFailedError("Task 77 failed: {}", "minimax"),
      new ProviderJobFailedError("Gemini Omni interaction i1 failed", "gemini"),
    ];
    for (const e of failures) {
      expect(classifyError(e), e.message).toMatchObject({
        code: "JOB_FAILED",
        exit_code: EXIT_CODES.rejected,
      });
    }
  });

  it("does not report a canceled, paused, unpaid or unusable job as a failed job", () => {
    const notFailures = [
      new ReplicatePredictionError({ id: "p2x9", status: "canceled" } as never),
      new AtlasPredictionFailedError({ id: "a2", status: "cancelled" } as never),
      new RunwayTaskError({ id: "t-3", status: "CANCELLED" } as never),
      new SumeJobError("j2", "canceled"),
      new HeygenJobFailedError(
        'HeyGen Video Agent session s1 ended with status "waiting_for_input"',
        "waiting_for_input",
        false,
      ),
      new TopviewPredictionError({ id: "tp2", status: "payment_required", outputs: [] } as never),
      new TopviewTaskError(
        { kind: "product_avatar", taskId: "t10", status: "success" } as never,
        ": no replaced image has a face",
      ),
    ];
    for (const e of notFailures) expect(classifyError(e).code, e.message).not.toBe("JOB_FAILED");
  });

  it("reports a moderation verdict on a failed job as the failed job it is", () => {
    const e = new RunwayTaskError({
      id: "t-2",
      status: "FAILED",
      failure: "Content moderation flagged the prompt",
    } as never);
    expect(classifyError(e).code).toBe("JOB_FAILED");
  });

  it("keeps the HTTP status of a download failure mixed into a HeyGen batch", () => {
    const e = new HeygenJobFailedError("video v2: HTTP 503 from https://x/y.mp4", undefined, false);
    expect(classifyError(e)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", http_status: 503 });
  });

  it("does not report a logged canceled job as a failed one", () => {
    expect(classifyMessage('Task failed: {"id":"cgt-1","status":"cancelled"}').code).not.toBe(
      "JOB_FAILED",
    );
    expect(classifyMessage('Task failed: {"id":"cgt-1","status":"failed"}').code).toBe(
      "JOB_FAILED",
    );
  });

  it("does not report a mix of job, poll and download failures as the provider's verdict", () => {
    const e = new HeygenJobFailedError(
      "1 of 2 translation jobs delivered; 1 failed:\nDownload of t1 failed: network",
      undefined,
      false,
    );
    expect(classifyError(e).code).not.toBe("JOB_FAILED");
  });

  it("does not take a failed request for a failed job", () => {
    expect(classifyMessage("Request failed: fetch failed").code).toBe("NETWORK_ERROR");
    expect(classifyMessage("request failed: ECONNRESET").code).toBe("NETWORK_ERROR");
    expect(classifyMessage("Generation failed: {}").code).toBe("JOB_FAILED");
    expect(classifyMessage("task polling failed: reset").code).not.toBe("JOB_FAILED");
  });

  it("reads a logged job failure that names the job id", () => {
    // MiniMax video logs the poll failure as text; HeyGen quotes the status.
    expect(classifyMessage('Task 3091846 failed: {"status":"Fail"}').code).toBe("JOB_FAILED");
    expect(classifyMessage('HeyGen video v1 ended with status "failed"').code).toBe("JOB_FAILED");
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
