/**
 * In-memory fake of the Runway HTTP API for offline tests.
 * Routes are matched by "METHOD /path" (path relative to BASE, or the full URL
 * for other hosts); each route holds a queue of responses, and the last one
 * repeats once drained.
 */

export const BASE = "https://runway.test";
export const SECRET = "key_TESTsecret1234567890abcdef";
export const TASK_ID = "0f0e0d0c-1111-4222-8333-444455556666";
export const OUTPUT_URL = "https://cdn.runway.test/out/video.mp4?sig=SIGNED_TOKEN_123";

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit | null;
}

export type FakeResponse =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; text: string; headers?: Record<string, string> }
  | { status?: number; bytes: Uint8Array; headers?: Record<string, string> }
  | { throws: Error };

export function createFakeRunway(routes: Record<string, FakeResponse[]>) {
  const calls: FakeCall[] = [];
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.startsWith(BASE) ? url.slice(BASE.length) : url}`;
    const rawHeaders =
      init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
    const headers = Object.fromEntries(
      Object.entries(rawHeaders as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, headers, body, rawBody: init.body ?? null });

    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`fake-runway: no route for ${key}`);
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

export function task(status: string, extra: Record<string, unknown> = {}) {
  return { id: TASK_ID, status, createdAt: "2026-10-15T00:00:00.000Z", ...extra };
}

export const noSleep = async () => {};
