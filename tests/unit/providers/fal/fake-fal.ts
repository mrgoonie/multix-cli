/**
 * Scripted fake of the fal endpoints the CLI calls (queue + storage), for
 * unit tests: routes are "METHOD url-prefix" -> queued responses (the last
 * one repeats). Records every call with its headers so tests can assert where
 * the key went and that nothing was submitted twice.
 */

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type FakeReply =
  | {
      status?: number;
      json?: unknown;
      body?: string | Uint8Array;
      headers?: Record<string, string>;
    }
  | { error: Error };

export function createFakeFal(routes: Record<string, FakeReply[]>) {
  const calls: FakeCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ method, url, headers, body: init?.body });
    const key = Object.keys(routes)
      .filter((k) => {
        const [m, prefix] = k.split(" ");
        return m === method && prefix !== undefined && url.startsWith(prefix);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`fake fal: no route for ${method} ${url}`);
    const queue = routes[key] as FakeReply[];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as FakeReply;
    if ("error" in reply) throw reply.error;
    if (reply.body !== undefined) {
      return new Response(reply.body, { status: reply.status ?? 200, headers: reply.headers });
    }
    return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

export const KEY = "fal-test-key-0123456789";
export const REQUEST_ID = "0b6c1a2e-1111-2222-3333-444455556666";
export const INITIATE = "https://rest.fal.ai/storage/upload/initiate";
export const UPLOAD_URL = "https://storage.example-cdn.test/upload/abc?X-Goog-Signature=sig";
export const FILE_URL = "https://v3.fal.media/files/abc/shot.mp4";

export function queueUrls(app: string) {
  return {
    status_url: `https://queue.fal.run/${app}/requests/${REQUEST_ID}/status`,
    response_url: `https://queue.fal.run/${app}/requests/${REQUEST_ID}`,
  };
}
