/**
 * Scriptable fake for both TopView APIs, injected as the clients' fetch.
 * Routes are matched by "METHOD path-substring"; each route holds a queue of
 * responses (the last one repeats). Every call is recorded for assertions.
 * `fail` simulates a transport error instead of an answer.
 */

import { TopviewLegacyClient } from "../../../../src/providers/topview/legacy-client.js";
import { TopviewPlatformClient } from "../../../../src/providers/topview/platform-client.js";

export const LEGACY_KEY = "tv-legacy-test-key-0123456789";
export const PLATFORM_KEY = "tv-platform-test-key-0123456789";
export const UID = "uid-123456";
export const LEGACY_BASE = "https://api.topview.ai";
export const PLATFORM_BASE = "https://platform-backend.topview.ai";

export interface FakeResponse {
  status?: number;
  body?: unknown;
  /** Raw text body (overrides `body`), e.g. a gateway's HTML page. */
  text?: string;
  headers?: Record<string, string>;
  fail?: "ECONNRESET" | "ECONNREFUSED" | "timeout";
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function transportError(kind: NonNullable<FakeResponse["fail"]>): Error {
  if (kind === "timeout") {
    return new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`connect ${kind}`), { code: kind }),
  });
}

export function createFakeTopview(routes: Record<string, FakeResponse[] | FakeResponse>) {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, FakeResponse[]>(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw text
      }
    }
    calls.push({ url: input, method, headers, body });

    const key = [...queues.keys()].find((k) => {
      const [m, part] = k.split(" ") as [string, string];
      return m === method && input.includes(part);
    });
    if (!key) throw new Error(`fake topview: no route for ${method} ${input}`);
    const queue = queues.get(key) as FakeResponse[];
    const res = (queue.length > 1 ? queue.shift() : queue[0]) as FakeResponse;
    if (res.fail) throw transportError(res.fail);
    return new Response(res.text ?? JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    });
  };

  const legacy = new TopviewLegacyClient({ apiKey: LEGACY_KEY, uid: UID, fetch });
  const platform = new TopviewPlatformClient({ apiKey: PLATFORM_KEY, fetch });
  return { legacy, platform, calls, fetch };
}

/** Legacy envelope: `code` is a string. */
export function ok(result: unknown) {
  return { code: "200", message: "Success", result };
}

export function legacyError(code: string, message: string) {
  return { code, message, result: null };
}

/** Platform envelope around a prediction. */
export function prediction(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { code: 0, message: "success", data: { id, status, ...extra } };
}

export function platformError(code: string, message: string, retryable = false) {
  return { error: { code, message, retryable } };
}

/** Sleep stub so polling tests do not wait. */
export const noSleep = async (): Promise<void> => {};
