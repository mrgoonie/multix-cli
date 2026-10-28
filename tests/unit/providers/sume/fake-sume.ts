/**
 * In-memory fake of the Sume HTTP API for offline tests.
 * Routes are matched by "METHOD /path" (path relative to BASE, or the full URL
 * for other hosts); each route holds a queue of responses, and the last one
 * repeats once drained.
 */

import fs from "node:fs";
import path from "node:path";

export const BASE = "https://sume.test";
export const KEY = "test-sume-key-NOT-A-SECRET-0123456789";
export const JOB_ID = "job_0f0e0d0c-1111-4222-8333-444455556666";
export const CATALOG_URL = "https://api.sume.com/v1/open/catalog";
export const ESTIMATE_URL = "https://api.sume.com/v1/open/estimate";
export const ARTIFACT_URL = "https://cdn.sume.test/out/a.png?sig=SIGNED_TOKEN_123";
export const UPLOAD_URL = "https://uploads.sume.test/put/abc?X-Signature=SIGNED_PUT_456";

export const CATALOG = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sume-catalog.json"), "utf8"),
) as unknown;

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

export function createFakeSume(routes: Record<string, FakeResponse[]>) {
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
    calls.push({ method, url, headers, body, rawBody: init.body ?? null, redirect: init.redirect });

    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`fake-sume: no route for ${key}`);
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

/** A submit (202) envelope for JOB_ID. */
export function submitted(extra: Record<string, unknown> = {}) {
  return {
    data: {
      request_id: JOB_ID,
      job: { id: JOB_ID, status: "queued", model: "gpt-image-2" },
      usage: { credits: 79, usd: "0.79" },
      idempotency_hit: false,
      next_poll_after_seconds: 2,
      ...extra,
    },
  };
}

/** A status (200) envelope for JOB_ID. */
export function status(sumeStatus: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      job_id: JOB_ID,
      sume_status: sumeStatus,
      terminal: ["completed", "failed", "canceled"].includes(sumeStatus),
      next_poll_after_seconds: 2,
      ...extra,
    },
  };
}

export function result(urls: string[] = [ARTIFACT_URL]) {
  return {
    data: {
      job_id: JOB_ID,
      result: { artifacts: urls.map((url, i) => ({ id: `a${i}`, type: "image", url })) },
    },
  };
}

export function apiError(code: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} happened`, request_id: "req_123", ...extra } };
}

export const noSleep = async () => {};
