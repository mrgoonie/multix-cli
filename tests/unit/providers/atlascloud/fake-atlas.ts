/**
 * Scriptable fake for the Atlas Cloud HTTP API, injected as the client's fetch.
 * Routes are matched by "METHOD pathSuffix"; each route holds a queue of
 * responses (the last one repeats). Every call is recorded for assertions.
 */

import { AtlasCloudClient } from "../../../../src/providers/atlascloud/client.js";

export const TEST_KEY = "atlas-test-key-0123456789abcdef";
export const BASE = "https://api.atlascloud.ai/api/v1";

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export function createFakeAtlas(routes: Record<string, FakeResponse[] | FakeResponse>) {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, FakeResponse[]>(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url: input, method, headers, body });

    const key = [...queues.keys()].find((k) => {
      const [m, suffix] = k.split(" ") as [string, string];
      return m === method && input.endsWith(suffix);
    });
    if (!key) throw new Error(`fake atlas: no route for ${method} ${input}`);
    const queue = queues.get(key) as FakeResponse[];
    const res = (queue.length > 1 ? queue.shift() : queue[0]) as FakeResponse;
    if (res.status === -1) throw new TypeError("fetch failed: ECONNRESET");
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    });
  };

  const client = new AtlasCloudClient({ apiKey: TEST_KEY, fetch });
  return { client, calls, fetch };
}

export function envelope(data: unknown, code = 200) {
  return { code, message: "", data };
}

export function prediction(id: string, status: string, extra: Record<string, unknown> = {}) {
  return envelope({ id, status, outputs: null, error: "", ...extra });
}

/** Minimal OpenAPI document shaped like Atlas's published model schemas. */
export function modelSchemaDoc(
  endpoint: "Image" | "Video" | "Audio",
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    openapi: "3.0.0",
    paths: {
      [`/api/v1/model/generate${endpoint}`]: {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Input" } } },
          },
        },
      },
      "/api/v1/model/result/{request_id}": { get: {} },
    },
    components: { schemas: { Input: { type: "object", properties, required } } },
  };
}

/** flux-schnell and seedance-v1-pro-fast schemas as published (trimmed). */
export const FLUX_SCHNELL_SCHEMA = modelSchemaDoc(
  "Image",
  {
    model: { type: "string", default: "black-forest-labs/flux-schnell" },
    prompt: { type: "string", default: "Cute boy with a hat" },
    size: { type: "string", default: "1024*1024" },
    num_images: { type: "integer", default: 1, minimum: 1, maximum: 4 },
    seed: { type: "integer", default: -1 },
    image: { type: "string", default: "" },
  },
  ["model", "prompt"],
);

export const SEEDANCE_T2V_SCHEMA = modelSchemaDoc(
  "Video",
  {
    model: { type: "string" },
    prompt: { type: "string" },
    aspect_ratio: { type: "string", enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
    duration: { type: "integer", enum: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], default: 5 },
    resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "480p" },
    seed: { type: "integer", default: -1 },
    camera_fixed: { type: "boolean", default: false },
  },
  ["model", "prompt"],
);

export function catalog(entries: Array<{ model: string; type: string; schema?: string }>) {
  return envelope(entries);
}
