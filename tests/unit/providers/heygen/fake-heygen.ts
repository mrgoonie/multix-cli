/**
 * Scriptable fake for the HeyGen API used by the heygen unit tests.
 * Routes are matched on "METHOD /path" (query ignored); each route returns
 * either a fixed reply or the next reply in a sequence (last one repeats).
 */

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Raw bytes/text body (for file downloads). */
  raw?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeHeygen {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
  callsTo: (route: string) => RecordedCall[];
}

function lowerHeaders(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries =
    h instanceof Headers ? [...h.entries()] : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

export function fakeHeygen(routes: Record<string, FakeReply | FakeReply[]>): FakeHeygen {
  const calls: RecordedCall[] = [];
  const cursor = new Map<string, number>();

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep raw
      }
    }
    calls.push({
      method,
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: lowerHeaders(init?.headers),
      body,
    });

    const key = `${method} ${parsed.pathname}`;
    const route = routes[key] ?? routes[`${method} ${parsed.origin}${parsed.pathname}`];
    if (!route) throw new Error(`fakeHeygen: no route for ${key}`);
    let reply: FakeReply;
    if (Array.isArray(route)) {
      const i = cursor.get(key) ?? 0;
      reply = route[Math.min(i, route.length - 1)] as FakeReply;
      cursor.set(key, i + 1);
    } else {
      reply = route;
    }
    const payload = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json", ...(reply.headers ?? {}) },
    });
  };

  return {
    fetch: fetchImpl,
    calls,
    callsTo: (route: string) => {
      const [m, p] = route.split(" ");
      return calls.filter((c) => c.method === m && c.path === p);
    },
  };
}

export const noSleep = async () => {};
