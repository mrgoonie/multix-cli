/**
 * BytePlus, OpenRouter and Leonardo commands that wait on a job, driven through
 * commander with global fetch stubbed. A job the provider fails is thrown as a
 * terminal ProviderJobFailedError (JOB_FAILED) naming the job, its status and
 * the provider's reason with URLs redacted, never the whole payload (it holds
 * the prompt). A canceled task is not a failed job and its reason cannot turn
 * it into another error class. A wait that runs out throws a POLL_TIMEOUT
 * error (TIMEOUT) naming the command that finishes the job. None of them call
 * process.exit. Fake timers skip the poll intervals. No network.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../../../src/core/error-classify.js";
import { ProviderJobFailedError } from "../../../src/core/errors.js";
import { registerBytePlusCommands } from "../../../src/providers/byteplus/commands/index.js";
import { registerLeonardoCommands } from "../../../src/providers/leonardo/commands/index.js";
import { registerOpenRouterCommands } from "../../../src/providers/openrouter/commands/index.js";

const SIGNED = "https://cdn.example.com/input.png?X-Signature=SECRET_TOKEN";
const REDACTED = "https://cdn.example.com/input.png?[redacted]";
const PROMPT = "a private prompt nobody should log";
const IMAGE = "https://cdn.example.com/frame.png";

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
  expect(exitSpy).not.toHaveBeenCalled();
  expect(String(result.error)).not.toMatch(/process\.exit/);
  return result.error;
}

/** Stub fetch: every POST returns `submitted`, every GET returns `status`. */
function stubFetch(status: unknown, submitted: unknown): void {
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.method ?? "GET") === "POST" ? submitted : status;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
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

const timeoutMessage = (noun: string, id: string, resume: string) =>
  `Timed out waiting for ${noun} ${id}; it may still finish. Check it later: ${resume}`;

describe("byteplus task waits", () => {
  const SUBMITTED = { id: "task-1" };
  const FAILED = {
    id: "task-1",
    status: "failed",
    content: { prompt: PROMPT },
    error: { code: "OutputVideoSensitiveContentDetected", message: `blocked ${SIGNED}` },
  };
  const FAILED_MESSAGE = `Task task-1 failed: OutputVideoSensitiveContentDetected: blocked ${REDACTED}`;
  const WAIT_DOWNLOAD = "multix byteplus status task-1 --wait --download";

  const commands: Array<[string, string[], string]> = [
    ["video", ["byteplus", "video", "--prompt", PROMPT], WAIT_DOWNLOAD],
    ["image-to-video", ["byteplus", "image-to-video", IMAGE, "--prompt", PROMPT], WAIT_DOWNLOAD],
    [
      "reference-to-video",
      [
        "byteplus",
        "reference-to-video",
        "--prompt",
        PROMPT,
        "--ref-image",
        IMAGE.replace(":", "\\:"),
      ],
      WAIT_DOWNLOAD,
    ],
    ["generate-3d", ["byteplus", "generate-3d", "--prompt", PROMPT], WAIT_DOWNLOAD],
    [
      "status --wait",
      ["byteplus", "status", "task-1", "--wait"],
      "multix byteplus status task-1 --wait",
    ],
    ["status --download", ["byteplus", "status", "task-1", "--download"], WAIT_DOWNLOAD],
  ];

  it.each(commands)("%s throws a failed task as a failed job", async (_name, argv) => {
    stubFetch(FAILED, SUBMITTED);
    const error = await runAndCatch(argv);
    expect(error).toBeInstanceOf(ProviderJobFailedError);
    expect(classifyError(error)).toMatchObject({ code: "JOB_FAILED", message: FAILED_MESSAGE });
  });

  it.each(commands)(
    "%s throws a timeout with the command that finishes it",
    async (_name, argv, resume) => {
      stubFetch({ id: "task-1", status: "running" }, SUBMITTED);
      const error = await runAndCatch([...argv, "--wait-timeout", "1"]);
      expect(classifyError(error)).toMatchObject({
        code: "TIMEOUT",
        message: timeoutMessage("task", "task-1", resume),
      });
    },
  );

  it.each([
    ["no reason", undefined],
    ["a reason naming a timeout", { code: "Cancelled", message: "cancelled after queue timeout" }],
    ["a reason naming invalid input", { message: "invalid parameter: field required" }],
  ])("reports a cancelled task with %s as a canceled job, not a failure", async (_name, reason) => {
    stubFetch({ id: "task-1", status: "cancelled", error: reason }, SUBMITTED);
    const error = await runAndCatch(["byteplus", "status", "task-1", "--wait"]);
    expect(error).toBeInstanceOf(ProviderJobFailedError);
    expect((error as ProviderJobFailedError).terminal).toBe(false);
    expect(classifyError(error)).toMatchObject({
      code: "UNKNOWN",
      message: "Task task-1 cancelled",
    });
  });
});

describe("openrouter video job waits", () => {
  const SUBMITTED = { id: "job-9", status: "pending" };
  const FAILED = { id: "job-9", status: "failed", error: `upstream rejected ${SIGNED}` };
  const commands: Array<[string, string[], string]> = [
    [
      "image-to-video --download",
      ["openrouter", "image-to-video", "--prompt", PROMPT, "--image-url", IMAGE, "--download"],
      "multix openrouter video-status job-9 --wait --download",
    ],
    [
      "image-to-video --wait",
      ["openrouter", "image-to-video", "--prompt", PROMPT, "--image-url", IMAGE, "--wait"],
      "multix openrouter video-status job-9 --wait",
    ],
    [
      "video-status --wait",
      ["openrouter", "video-status", "job-9", "--wait"],
      "multix openrouter video-status job-9 --wait",
    ],
  ];

  it.each(commands)("%s throws a failed job as a failed job", async (_name, argv) => {
    stubFetch(FAILED, SUBMITTED);
    const error = await runAndCatch(argv);
    expect(classifyError(error)).toMatchObject({
      code: "JOB_FAILED",
      message: `Job job-9 failed: upstream rejected ${REDACTED}`,
    });
  });

  it.each(commands)(
    "%s throws a timeout with the command that finishes it",
    async (_name, argv, resume) => {
      stubFetch({ id: "job-9", status: "in_progress" }, SUBMITTED);
      const error = await runAndCatch([...argv, "--wait-timeout", "1"]);
      expect(classifyError(error)).toMatchObject({
        code: "TIMEOUT",
        message: timeoutMessage("job", "job-9", resume),
      });
    },
  );
});

describe("leonardo generation waits", () => {
  const SUBMITTED = {
    sdGenerationJob: { generationId: "gen-5" },
    generate: { generationId: "gen-5" },
    motionVideoGenerationJob: { generationId: "gen-5" },
  };
  const WAIT_DOWNLOAD = "multix leonardo status gen-5 --wait --download";
  const commands: Array<[string, string[], string]> = [
    ["generate", ["leonardo", "generate", PROMPT], WAIT_DOWNLOAD],
    [
      "generate --no-download",
      ["leonardo", "generate", PROMPT, "--no-download"],
      "multix leonardo status gen-5 --wait",
    ],
    [
      "image-to-image",
      ["leonardo", "image-to-image", "--prompt", PROMPT, "--ref", "img-1"],
      WAIT_DOWNLOAD,
    ],
    ["video --download", ["leonardo", "video", PROMPT, "--download"], WAIT_DOWNLOAD],
    [
      "video --wait",
      ["leonardo", "video", PROMPT, "--wait"],
      "multix leonardo status gen-5 --wait",
    ],
    [
      "status --wait",
      ["leonardo", "status", "gen-5", "--wait"],
      "multix leonardo status gen-5 --wait",
    ],
  ];

  it.each(commands)(
    "%s throws a failed generation as a failed job without the payload",
    async (_name, argv) => {
      stubFetch(
        { generations_by_pk: { id: "gen-5", status: "FAILED", prompt: PROMPT } },
        SUBMITTED,
      );
      const error = await runAndCatch(argv);
      expect(classifyError(error)).toMatchObject({
        code: "JOB_FAILED",
        message: "Generation gen-5 failed",
      });
    },
  );

  it.each(commands)(
    "%s throws a timeout with the command that finishes it",
    async (_name, argv, resume) => {
      stubFetch(
        { generations_by_pk: { id: "gen-5", status: "PENDING", prompt: PROMPT } },
        SUBMITTED,
      );
      const error = await runAndCatch([...argv, "--wait-timeout", "1"]);
      expect(classifyError(error)).toMatchObject({
        code: "TIMEOUT",
        message: timeoutMessage("generation", "gen-5", resume),
      });
    },
  );
});
