/**
 * Generic polling helper. Ported from leonardo-cli/src/utils/poll.ts.
 */

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
