/**
 * One creating request to TopView, never retried (runtime-neutral: no node:*
 * imports). A second submit is a second paid task, so every outcome that does
 * not prove "nothing was created" becomes UNKNOWN_REMOTE_STATE instead of an
 * ordinary, retryable error.
 */

import { HttpError, MultixError } from "../../core/errors.js";
import { toFetchError } from "../../core/fetch-error.js";
import { type FetchLike, parseRetryAfter } from "../../core/fetch-json.js";
import { fetchFollowingRedirects } from "../../core/redirect-fetch.js";
import {
  NOT_SENT_CODES,
  UNKNOWN_REMOTE_STATE,
  errorCodes,
  readCappedText,
} from "../../core/response-read.js";
import { TOPVIEW_PROVIDER } from "./models.js";

const BODY_MAX = 1024 * 1024;
const SNIPPET_MAX = 500;

export interface SendOnceOptions {
  url: string;
  /** Request name used in errors ("Avatar Marketing Video submit", ...). */
  what: string;
  headers: Record<string, string>;
  body: string | FormData;
  timeoutMs: number;
  /** What to do before sending again, appended to an unknown-outcome error. */
  advice: string;
  /** True when the error body is TopView's own answer (a definite refusal). */
  isProviderError: (text: string) => boolean;
  /** TopView's error text from its error body, capped. */
  errorMessage: (text: string) => string;
  fetch?: FetchLike;
}

/** A creating request whose outcome (and billing) is unknown. */
export function unknownRemoteState(
  what: string,
  reason: string,
  advice: string,
  cause?: unknown,
): MultixError {
  return new MultixError(
    `TopView ${what} was cut off (${reason}) after it may have been accepted, so a task may exist and be billed: ${advice}`,
    UNKNOWN_REMOTE_STATE,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Send once and return the 2xx body text. Errors: HttpError for TopView's own
 * error answer (nothing created), UNKNOWN_REMOTE_STATE when the connection
 * broke after sending, a gateway answered without TopView's error body, or a
 * server error interrupted a request that may already have created the task.
 * A 503 with TopView's body ("busy") is a definite refusal.
 */
export async function sendOnce(opts: SendOnceOptions): Promise<string> {
  let response: Response;
  try {
    ({ response } = await fetchFollowingRedirects(
      opts.url,
      {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      },
      { fetch: opts.fetch, crossOrigin: "error" },
    ));
  } catch (cause) {
    // A refused cross-origin redirect is an answer, not a lost connection.
    if (cause instanceof MultixError) throw cause;
    const mapped = toFetchError(cause, opts.url, { provider: TOPVIEW_PROVIDER });
    const notSent = errorCodes(cause).some((c) => NOT_SENT_CODES.has(c));
    if (mapped instanceof HttpError && mapped.status === 0 && !notSent) {
      throw unknownRemoteState(opts.what, mapped.snippet || "connection lost", opts.advice, cause);
    }
    throw mapped;
  }

  const text = await readCappedText(response, BODY_MAX);
  if (response.ok) {
    if (text === "(could not read body)") {
      throw unknownRemoteState(opts.what, "response body was cut off", opts.advice);
    }
    return text;
  }
  const serverError = response.status >= 500;
  if (serverError && (response.status !== 503 || !opts.isProviderError(text))) {
    throw unknownRemoteState(opts.what, `HTTP ${response.status}`, opts.advice);
  }
  throw new HttpError(
    response.status,
    opts.errorMessage(text).slice(0, SNIPPET_MAX),
    opts.url,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

/** Parse a JSON body, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
