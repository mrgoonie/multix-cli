/**
 * In-memory fake of both TopView HTTP APIs for offline tests.
 * Routes are keyed "METHOD <path>" for the legacy API (path relative to
 * LEGACY_BASE, without the query string) and "METHOD <full URL without query>"
 * for every other host (API Platform, storage, CDN). Each route holds a queue
 * of responses; the last one repeats once drained.
 */

export const LEGACY_BASE = "https://topview.test";
export const PLATFORM_BASE = "https://platform.topview.test/api/v1";
export const KEY = "test-topview-key-NOT-A-SECRET";
export const UID = "uid_0123456789";
export const PLATFORM_KEY = "test-topview-platform-key-NOT-A-SECRET";
export const UPLOAD_URL = "https://upload.topview-cdn.test/put/file_1?X-Sig=UPLOAD_SIGNATURE";
export const VIDEO_URL = "https://cdn.topview-cdn.test/out/video.mp4?sig=SIGNED_TOKEN_123";
export const IMAGE_URL = "https://cdn.topview-cdn.test/out/image.png?sig=SIGNED_TOKEN_456";
export const TASK_ID = "task_0123456789abcdef";
export const PREDICTION_ID = "pred0123456789abcdef";

export interface FakeCall {
  method: string;
  url: string;
  key: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit | null;
  redirect?: RequestRedirect;
}

export type FakeResponse =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; text: string; headers?: Record<string, string> }
  | { status?: number; bytes: Uint8Array; headers?: Record<string, string> }
  | { throws: Error };

export function routeKey(method: string, url: string): string {
  const noQuery = url.split("?")[0] as string;
  const target = noQuery.startsWith(`${LEGACY_BASE}/`)
    ? noQuery.slice(LEGACY_BASE.length)
    : noQuery;
  return `${method} ${target}`;
}

export function createFakeTopview(routes: Record<string, FakeResponse[]>) {
  const calls: FakeCall[] = [];
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const key = routeKey(method, url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const query = Object.fromEntries(new URL(url).searchParams);
    calls.push({
      method,
      url,
      key,
      query,
      headers,
      body,
      rawBody: init.body ?? null,
      redirect: init.redirect,
    });

    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`fake-topview: no route for ${key}`);
    const next = (queue.length > 1 ? queue.shift() : queue[0]) as FakeResponse;
    if ("throws" in next) throw next.throws;
    const status = next.status ?? 200;
    if ("json" in next) {
      return new Response(JSON.stringify(next.json), {
        status,
        headers: { "content-type": "application/json", ...next.headers },
      });
    }
    if ("text" in next) {
      return new Response(status === 204 ? null : next.text, { status, headers: next.headers });
    }
    return new Response(next.bytes, { status, headers: next.headers });
  };
  return { fetch, calls };
}

/** A legacy success envelope. */
export function ok(result: unknown): FakeResponse {
  return { json: { code: "200", message: "Success", result } };
}

/** A legacy error envelope (HTTP 200 with a non-200 code). */
export function envelopeError(code: string, message = "failed"): FakeResponse {
  return { json: { code, message, result: null } };
}

/** A platform success envelope. */
export function data(value: unknown): FakeResponse {
  return { json: { code: 200, message: "success", data: value } };
}

export function prediction(status: string, extra: Record<string, unknown> = {}) {
  return { id: PREDICTION_ID, status, created_at: "2026-10-28T00:00:00Z", ...extra };
}

export const noSleep = async () => {};
