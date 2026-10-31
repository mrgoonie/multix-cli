/**
 * Generic polling helper. Ported from leonardo-cli/src/utils/poll.ts.
 */

import { PollTimeoutError as JobPollTimeoutError } from "../../core/async-poll.js";
import { ProviderJobFailedError } from "../../core/errors.js";
import { redactUrlsInText } from "../../core/redact.js";

export interface PollOptions<T> {
  fetch: () => Promise<T>;
  done: (value: T) => boolean;
  failed?: (value: T) => boolean;
  intervalMs?: number;
  maxAttempts?: number;
  onTick?: (attempt: number, value: T) => void;
  signal?: AbortSignal;
}

export class PollTimeoutError extends Error {
  constructor() {
    super("Polling timed out before the operation completed.");
    this.name = "PollTimeoutError";
  }
}

export class PollFailedError extends Error {
  constructor(public readonly value: unknown) {
    super("Operation failed.");
    this.name = "PollFailedError";
  }
}

export async function poll<T>(opts: PollOptions<T>): Promise<T> {
  const interval = opts.intervalMs ?? 4000;
  const max = opts.maxAttempts ?? 120;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    const value = await opts.fetch();
    opts.onTick?.(attempt, value);
    if (opts.failed?.(value)) throw new PollFailedError(value);
    if (opts.done(value)) return value;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("Aborted"));
      });
    });
  }
  throw new PollTimeoutError();
}

/** What a failed poll value says about the job. */
export interface PollJobFailure {
  /** The provider's status word ("failed", "cancelled", "FAILED"). */
  status: unknown;
  /** The provider's failure reason (its error field), never the whole payload. */
  reason?: string;
  /**
   * True when the provider itself failed the job; false for a cancel, so the
   * run is not reported as a failed job.
   */
  terminal: boolean;
}

export interface PollJob {
  provider: string;
  /** How the provider names the job in messages: "Task", "Job", "Generation". */
  noun: string;
  id: string;
  /** Command that finishes the job later, shown when the wait times out. */
  resumeCommand: string;
  /** Read the status, reason and verdict from the value the poll failed on. */
  describe: (value: unknown) => PollJobFailure;
}

/**
 * A provider's error field as one line: a string as is, `code: message` from
 * an object that has either, otherwise its JSON. Undefined when absent.
 */
export function failureReason(error: unknown): string | undefined {
  if (error === undefined || error === null || error === "") return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const parts = [code, message].filter((p) => typeof p === "string" && p !== "");
    if (parts.length > 0) return parts.join(": ");
  }
  return JSON.stringify(error) ?? String(error);
}

/** Only a plain status word goes into the message; anything else reads "failed". */
function statusWord(status: unknown): string {
  return typeof status === "string" && /^[A-Za-z_-]{1,32}$/.test(status)
    ? status.toLowerCase()
    : "failed";
}

/**
 * Map a `poll()` failure onto the CLI error hierarchy so the run is classified
 * from the error itself. A failed status becomes ProviderJobFailedError naming
 * the job, its status and, when the provider failed it, the provider's reason
 * (URLs redacted). A canceled job's message carries no reason, so its text
 * cannot be read as some other error class. A timeout becomes a POLL_TIMEOUT
 * error naming the job and the command that finishes it. Any other error is
 * returned unchanged. Callers throw the result.
 */
export function toPollJobError(error: unknown, job: PollJob): unknown {
  if (error instanceof PollFailedError) {
    const failure = job.describe(error.value);
    const reason =
      failure.terminal && failure.reason ? `: ${redactUrlsInText(failure.reason)}` : "";
    return new ProviderJobFailedError(
      `${job.noun} ${job.id} ${statusWord(failure.status)}${reason}`,
      job.provider,
      { cause: error, terminal: failure.terminal },
    );
  }
  // This module's own timeout (no code) becomes the shared POLL_TIMEOUT error.
  if (error instanceof PollTimeoutError) {
    return new JobPollTimeoutError(
      `Timed out waiting for ${job.noun.toLowerCase()} ${job.id}; it may still finish. Check it later: ${job.resumeCommand}`,
    );
  }
  return error;
}

/** `toPollJobError` for a Leonardo generation (its status payload has no reason field). */
export function toGenerationError(
  error: unknown,
  generationId: string,
  resumeCommand: string,
): unknown {
  return toPollJobError(error, {
    provider: "leonardo",
    noun: "Generation",
    id: generationId,
    resumeCommand,
    describe: (value) => ({
      status: (value as { generations_by_pk?: { status?: unknown } | null } | null)
        ?.generations_by_pk?.status,
      terminal: true,
    }),
  });
}
