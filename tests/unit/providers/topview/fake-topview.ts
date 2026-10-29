/**
 * In-memory fake of both TopView hosts (Legacy API and API Platform) for
 * offline tests. Routes are matched by "METHOD /path?query" relative to
 * LEGACY_BASE or PLATFORM_BASE, or by "METHOD <full url>" for other hosts
 * (presigned upload URLs, CDN outputs). Each route holds a queue of responses;
 * the last one repeats once drained.
 */

export const LEGACY_BASE = "https://api.topview.test";
export const PLATFORM_BASE = "https://platform.topview.test";
export const LEGACY_KEY = "tvk_LEGACYsecret1234567890abcdef";
export const UID = "uid_4242424242";
export const PLATFORM_KEY = "tvp_PLATFORMsecret0987654321fedcba";
export const TASK_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const PREDICTION_ID = "01KQ8Z9Y7X6W5V4T3S2R1P0N9M";
export const UPLOAD_URL = "https://s3.topview.test/uploads/abc?X-Amz-Signature=SIGNED_UPLOAD_SIG";
export const VIDEO_URL =
  "https://cdn.topview.test/out/video.mp4?Expires=1&Signature=SIGNED_OUT_SIG";
export const IMAGE_URL =
  "https://cdn.topview.test/out/image.png?Expires=1&Signature=SIGNED_OUT_SIG";

export interface FakeCall {
  method: string;
  url: string;
  /** Route key ("POST /v1/m2v/task/submit" or "PUT https://..."). */
  key: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit | null;
}

export type FakeResponse =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; text: string; headers?: Record<string, string> }
  | { status?: number; bytes: Uint8Array; headers?: Record<string, string> }
  | { throws: Error };

function routeKey(method: string, url: string): string {
  for (const base of [LEGACY_BASE, PLATFORM_BASE]) {
    if (url.startsWith(`${base}/`)) return `${method} ${url.slice(base.length)}`;
  }
  return `${method} ${url}`;
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
    const rawHeaders =
      init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
    const headers = Object.fromEntries(
      Object.entries(rawHeaders as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, key, headers, body, rawBody: init.body ?? null });

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
    if ("text" in next) return new Response(next.text, { status, headers: next.headers });
    return new Response(next.bytes, { status, headers: next.headers });
  };
  return { fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

/** Legacy envelope `{ code: "200", message, result }`. */
export function ok(result: unknown): FakeResponse {
  return { json: { code: "200", message: "success", result } };
}

/** Legacy business error envelope (HTTP 200, non-"200" code). */
export function legacyError(code: string, message = "error"): FakeResponse {
  return { json: { code, message, result: null } };
}

/** Platform envelope `{ code: 200, message, data }`. */
export function data(value: unknown): FakeResponse {
  return { json: { code: 200, message: "OK", data: value } };
}

export function prediction(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: PREDICTION_ID,
    status,
    created_at: "2026-10-28T09:00:00Z",
    code: 0,
    outputs: [],
    ...extra,
  };
}

/** Routes for one successful upload of `fileId` (credential → PUT → check). */
export function uploadRoutes(
  format: string,
  fileId: string,
  uploadUrl = UPLOAD_URL,
): Record<string, FakeResponse[]> {
  return {
    [`GET /v1/upload/credential?format=${format}`]: [ok({ fileId, uploadUrl, format })],
    [`PUT ${uploadUrl}`]: [{ text: "" }],
    [`GET /v1/upload/check?fileId=${fileId}`]: [ok(true)],
  };
}

export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

export const noSleep = async () => {};
