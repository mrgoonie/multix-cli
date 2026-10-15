/**
 * MCP Events callback verification: before a subscription is accepted, the
 * server POSTs a signed `{ "type": "verification", "challenge": … }` message
 * to the callback and expects a 2xx answer echoing the challenge. This proves
 * the receiver wants the traffic, so the server cannot be used to flood a URL
 * someone else owns. Redirects are never followed.
 */

import type { FetchLike } from "../../../src/core/fetch-json.js";
import { randomBase64Url } from "../accounts/base64.js";
import { tokensMatch } from "../http-guards.js";
import { webhookHeaders } from "./webhook-signing.js";

export const VERIFICATION_TIMEOUT_MS = 10_000;
/** Largest verification answer read; it only needs to carry the challenge. */
const MAX_ANSWER_BYTES = 4_096;

/**
 * Failure categories reported to the client in `data.reason`. Only the
 * category leaves the server, never the endpoint's body, headers or status.
 */
export type VerificationFailure =
  | "challenge_failed"
  | "timeout"
  | "connection_refused"
  | "http_4xx"
  | "http_5xx";

async function readLimited(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function statusFailure(status: number): VerificationFailure {
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  // 1xx/3xx: a redirect is not followed and does not answer the challenge.
  return "challenge_failed";
}

/** Send the challenge; null when the callback echoed it, otherwise the failure category. */
export async function verifyCallback(
  fetchFn: FetchLike,
  url: string,
  secret: string,
  subscriptionId: string,
  now: () => number = Date.now,
): Promise<VerificationFailure | null> {
  const challenge = randomBase64Url(32);
  const body = JSON.stringify({ type: "verification", challenge });
  const id = `msg_verification_${randomBase64Url(16)}`;
  const headers = await webhookHeaders(
    [secret],
    id,
    Math.floor(now() / 1000),
    body,
    subscriptionId,
  );
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection_refused";
  }
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel();
    return statusFailure(response.status);
  }
  let answered: unknown;
  try {
    const text = await readLimited(response);
    if (text === null) return "challenge_failed";
    answered = (JSON.parse(text) as { challenge?: unknown }).challenge;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "TimeoutError" || name === "AbortError" ? "timeout" : "challenge_failed";
  }
  if (typeof answered !== "string" || !(await tokensMatch(answered, challenge))) {
    return "challenge_failed";
  }
  return null;
}
