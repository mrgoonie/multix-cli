/**
 * In-memory fake of the Runway Dev API for offline tests.
 * Routes are matched by "METHOD /path" (path relative to the base URL, or the
 * full URL for other hosts); each route holds a queue of responses, and the
 * last one repeats once drained.
 */

export const BASE = "https://runway.test";
export const SECRET = "key_TESTsecret1234567890abcdefSECRET";
export const TASK_ID = "17f20503-6c24-4c16-946b-35dbbce2af2f";
export const OUTPUT_URL = "https://cdn.runway.test/out/video.mp4?sig=SIGNEDsecret";
export const IMAGE_URL = "https://cdn.runway.test/out/image.png?sig=SIGNEDsecret";

export interface FakeCall {
  method: string;
  url: string;
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
      init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
    const headers = Object.fromEntries(
      Object.entries((rawHeaders ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, headers, body, rawBody: init.body ?? null, redirect: init.redirect });

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
      return new Response(next.text === "" ? null : next.text, { status, headers: next.headers });
    }
    return new Response(next.bytes, { status, headers: next.headers });
  };
  return { fetch, calls };
}

export function task(status: string, extra: Record<string, unknown> = {}) {
  return { id: TASK_ID, status, createdAt: "2026-10-15T00:00:00.000Z", ...extra };
}

export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

export const noSleep = async () => {};
