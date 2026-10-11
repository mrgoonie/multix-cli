/**
 * Bounded polling for asynchronous provider jobs (predictions, video renders).
 * Runtime-neutral (no node:* imports): exponential backoff with jitter, a hard
 * deadline, transient-error retries, and Retry-After support on 429.
 */

import { HttpError, MultixError } from "./errors.js";

export class PollTimeoutError extends MultixError {
  constructor(
    message: string,
    public readonly lastStatus?: unknown,
  ) {
    super(message, "POLL_TIMEOUT");
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions<T> {
  /**
   * Fetch the current job state. `remainingMs` is the time left before the
   * deadline; use it as the request timeout so one slow request cannot
   * overrun the overall wait.
   */
  fetchStatus: (ctx: { remainingMs: number; attempt: number }) => Promise<T>;
  /** True once the job reached a terminal state (success OR failure). */
  isTerminal: (state: T) => boolean;
  /** Hard upper bound for the whole wait. */
  timeoutMs: number;
  /** First delay between polls. Default 3000ms. */
  intervalMs?: number;
  /** Ceiling for the backoff delay. Default 15000ms. */
  maxIntervalMs?: number;
  /** Multiplier applied after each poll. Default 1.5. */
  backoffFactor?: number;
  /** Add up to ±20% random jitter to each delay. Default true. */
  jitter?: boolean;
  /** Lower bound for any delay, including Retry-After: 0. Default 500ms. */
  minIntervalMs?: number;
  /** Errors that should be retried instead of aborting. Default: network/timeout, 408, 429, 5xx. */
  isTransientError?: (error: unknown) => boolean;
  /** Called after each successful status fetch. */
  onPoll?: (state: T, attempt: number) => void;
  /** Appended to the timeout message, e.g. a resume command. */
  resumeHint?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * Network failures and timeouts (status 0), 408, rate limits and server errors
 * are worth retrying. Anything else — ConfigError, ValidationError, other 4xx,
 * plain errors — fails the same way on every attempt.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const { status } = error;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fetchStatus` until `isTerminal` returns true or the deadline passes.
 * Returns the terminal state; callers decide whether it is success or failure.
 * Throws PollTimeoutError on timeout and rethrows non-transient errors.
 */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const isTransient = opts.isTransientError ?? isTransientHttpError;
  const maxInterval = opts.maxIntervalMs ?? 15_000;
  const minInterval = opts.minIntervalMs ?? 500;
  const factor = opts.backoffFactor ?? 1.5;
  const jitter = opts.jitter ?? true;
  const deadline = now() + opts.timeoutMs;

  let interval = opts.intervalMs ?? 3000;
  let attempt = 0;
  let last: T | undefined;
  let lastError: unknown;

  for (;;) {
    attempt++;
    let retryAfterMs: number | undefined;
    try {
      last = await opts.fetchStatus({ remainingMs: Math.max(1, deadline - now()), attempt });
      lastError = undefined;
      opts.onPoll?.(last, attempt);
      if (opts.isTerminal(last)) return last;
    } catch (error) {
      if (!isTransient(error)) throw error;
      lastError = error;
      if (error instanceof HttpError) retryAfterMs = error.retryAfterMs;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      const hint = opts.resumeHint ? ` ${opts.resumeHint}` : "";
      const cause = lastError instanceof Error ? ` Last error: ${lastError.message}.` : "";
      throw new PollTimeoutError(
        `Timed out after ${opts.timeoutMs}ms waiting for job.${cause}${hint}`,
        last,
      );
    }

    let delay = retryAfterMs ?? interval;
    if (jitter && retryAfterMs === undefined) delay *= 0.8 + random() * 0.4;
    await sleep(Math.min(Math.max(delay, minInterval), remaining));
    interval = Math.min(interval * factor, maxInterval);
  }
}
