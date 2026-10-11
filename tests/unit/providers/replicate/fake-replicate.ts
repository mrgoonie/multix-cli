/**
 * In-memory fake of the Replicate HTTP API for offline tests.
 * Routes are matched by "METHOD /path" (path relative to the base URL); each
 * route holds a queue of responses, and the last one repeats once drained.
 */

export const BASE = "https://replicate.test/v1";
export const TOKEN = "r8_TESTtoken1234567890SECRET";

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

export function createFakeReplicate(routes: Record<string, FakeResponse[]>) {
  const calls: FakeCall[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${input.startsWith(BASE) ? input.slice(BASE.length) : input}`;
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url: input, headers, body, rawBody: init.body ?? null });

    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`fake-replicate: no route for ${key}`);
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
  return { fetch, calls };
}

export function prediction(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    model: "black-forest-labs/flux-schnell",
    version: "hidden",
    input: { prompt: "secret prompt" },
    logs: "step 1",
    urls: {
      get: `${BASE}/predictions/${id}`,
      cancel: `${BASE}/predictions/${id}/cancel`,
      web: `https://replicate.com/p/${id}`,
    },
    ...extra,
  };
}

export const noSleep = async () => {};
