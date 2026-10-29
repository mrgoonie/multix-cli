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

export interface PollJob {
  provider: string;
  /** How the provider names the job in messages: "Task", "Job", "Generation". */
  noun: string;
  id: string;
  /** Command that checks on the job later, shown when the wait times out. */
  resumeCommand: string;
  /**
   * Whether the failed value is the provider's own verdict that the job failed
   * (the default). Return false for a canceled job so the run is not reported
   * as a failed job.
   */
  terminal?: (value: unknown) => boolean;
}

/**
 * Map a `poll()` failure onto the CLI error hierarchy so the run is classified
 * from the error itself: a failed status becomes ProviderJobFailedError with
 * the job id and the provider's reason (URLs redacted), a timeout becomes a
 * POLL_TIMEOUT error naming the job and the command that checks on it. Any
 * other error is returned unchanged. Callers throw the result.
 */
export function toPollJobError(error: unknown, job: PollJob): unknown {
  if (error instanceof PollFailedError) {
    const detail = redactUrlsInText(JSON.stringify(error.value) ?? String(error.value));
    return new ProviderJobFailedError(`${job.noun} ${job.id} failed: ${detail}`, job.provider, {
      cause: error,
      terminal: job.terminal?.(error.value) ?? true,
    });
  }
  if (error instanceof PollTimeoutError) {
    return new JobPollTimeoutError(
      `Timed out waiting for ${job.noun.toLowerCase()} ${job.id}; it may still finish. Check it later: ${job.resumeCommand}`,
    );
  }
  return error;
}
