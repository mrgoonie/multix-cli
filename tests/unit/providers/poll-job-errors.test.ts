/**
 * BytePlus, OpenRouter and Leonardo commands that wait on a job, driven through
 * commander with global fetch stubbed: a job the provider fails is thrown as a
 * terminal ProviderJobFailedError (JOB_FAILED) carrying the job id and the
 * provider's reason with URLs redacted, a canceled task is not reported as a
 * failed job, and a wait that runs out throws a POLL_TIMEOUT error (TIMEOUT)
 * naming the command that checks on the job. None of them call process.exit.
 * Fake timers skip the poll intervals. No network.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../src/core/error-classify.js";
import { ProviderJobFailedError } from "../../../src/core/errors.js";
import { registerBytePlusCommands } from "../../../src/providers/byteplus/commands/index.js";
import { registerLeonardoCommands } from "../../../src/providers/leonardo/commands/index.js";
import { registerOpenRouterCommands } from "../../../src/providers/openrouter/commands/index.js";

const SIGNED = "https://cdn.example.com/input.png?X-Signature=SECRET_TOKEN";

let exitSpy: ReturnType<typeof vi.spyOn>;

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerBytePlusCommands(root);
  registerOpenRouterCommands(root);
  registerLeonardoCommands(root);
  return root;
}

/** Run argv to completion (fast-forwarding poll sleeps) and return what it threw. */
async function runAndCatch(argv: string[]): Promise<unknown> {
  const outcome = program()
    .parseAsync(argv, { from: "user" })
    .then(
      () => ({ threw: false as const }),
      (error: unknown) => ({ threw: true as const, error }),
    );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (!result.threw) throw new Error(`expected ${argv.join(" ")} to throw`);
  return result.error;
}

/** Stub fetch: POST returns `submitted`, every GET returns `status`. */
function stubFetch(status: unknown, submitted: unknown = { id: "task-1" }): void {
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.method ?? "GET") === "POST" ? submitted : status;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function expectNoExit(error: unknown): void {
  expect(exitSpy).not.toHaveBeenCalled();
  expect(String(error)).not.toMatch(/process\.exit/);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubEnv("BYTEPLUS_API_KEY", "bp-test-key");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-key");
  vi.stubEnv("LEONARDO_API_KEY", "leo-test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("byteplus task waits", () => {
  const failed = {
    id: "task-1",
    status: "failed",
    error: { code: "OutputVideoSensitiveContentDetected", message: `blocked ${SIGNED}` },
  };

  it("throws a failed status from status --wait as a failed job", async () => {
    stubFetch(failed);
    const error = await runAndCatch(["byteplus", "status", "task-1", "--wait"]);
    expectNoExit(error);
    expect(error).toBeInstanceOf(ProviderJobFailedError);
    const info = classifyError(error);
    expect(info.code).toBe("JOB_FAILED");
    expect(info.message).toContain("Task task-1 failed");
    expect(info.message).toContain("OutputVideoSensitiveContentDetected");
    expect(info.message).not.toContain("SECRET_TOKEN");
  });

  it("throws a failed status after submitting a video as a failed job", async () => {
    stubFetch(failed);
    const error = await runAndCatch(["byteplus", "video", "--prompt", "a cat"]);
    expectNoExit(error);
    expect(classifyError(error).code).toBe("JOB_FAILED");
  });

  it("does not report a cancelled task as a failed job", async () => {
    stubFetch({ id: "task-1", status: "cancelled" });
    const error = await runAndCatch(["byteplus", "status", "task-1", "--wait"]);
    expectNoExit(error);
    expect(error).toBeInstanceOf(ProviderJobFailedError);
    expect((error as ProviderJobFailedError).terminal).toBe(false);
    expect(classifyError(error).code).not.toBe("JOB_FAILED");
  });

  it("throws a timeout naming the task and how to check on it", async () => {
    stubFetch({ id: "task-1", status: "running" });
    const error = await runAndCatch([
      "byteplus",
      "video",
      "--prompt",
      "a cat",
      "--wait-timeout",
      "1",
    ]);
    expectNoExit(error);
    const info = classifyError(error);
    expect(info.code).toBe("TIMEOUT");
    expect(info.message).toContain("multix byteplus status task-1");
  });
});

describe("openrouter video-status --wait", () => {
  it("throws a failed job as a failed job", async () => {
    stubFetch({ id: "job-9", status: "failed", error: `upstream rejected ${SIGNED}` });
    const error = await runAndCatch(["openrouter", "video-status", "job-9", "--wait"]);
    expectNoExit(error);
    const info = classifyError(error);
    expect(info.code).toBe("JOB_FAILED");
    expect(info.message).toContain("Job job-9 failed");
    expect(info.message).toContain("upstream rejected");
    expect(info.message).not.toContain("SECRET_TOKEN");
  });

  it("throws a timeout naming the job and how to check on it", async () => {
    stubFetch({ id: "job-9", status: "in_progress" });
    const error = await runAndCatch([
      "openrouter",
      "video-status",
      "job-9",
      "--wait",
      "--wait-timeout",
      "1",
    ]);
    expectNoExit(error);
    const info = classifyError(error);
    expect(info.code).toBe("TIMEOUT");
    expect(info.message).toContain("multix openrouter video-status job-9");
  });
});

describe("leonardo status --wait", () => {
  it("throws a failed generation as a failed job", async () => {
    stubFetch({ generations_by_pk: { id: "gen-5", status: "FAILED" } });
    const error = await runAndCatch(["leonardo", "status", "gen-5", "--wait"]);
    expectNoExit(error);
    const info = classifyError(error);
    expect(info.code).toBe("JOB_FAILED");
    expect(info.message).toContain("Generation gen-5 failed");
  });

  it("throws a timeout naming the generation and how to check on it", async () => {
    stubFetch({ generations_by_pk: { id: "gen-5", status: "PENDING" } });
    const error = await runAndCatch([
      "leonardo",
      "status",
      "gen-5",
      "--wait",
      "--wait-timeout",
      "1",
    ]);
    expectNoExit(error);
    const info = classifyError(error);
    expect(info.code).toBe("TIMEOUT");
    expect(info.message).toContain("multix leonardo status gen-5");
  });
});
