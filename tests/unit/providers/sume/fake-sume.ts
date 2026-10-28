/**
 * Test doubles for the Sume API: a catalog shaped like GET /v1/open/catalog
 * (entries trimmed from the public catalog) and a recording fake fetch.
 */

import type { SumeCatalogModel } from "../../../../src/providers/sume/types.js";

export const CATALOG_MODELS: SumeCatalogModel[] = [
  {
    id: "seedream-v4",
    kind: "image",
    modes: ["text-to-image", "image-edit"],
    pricing: {
      currency: "USD",
      unit: "image",
      from_usd: "0.0300",
      to_usd: "0.0300",
      options: [{ label: "per image", usd: "0.0300", usd_micros: 30000 }],
    },
    capabilities: {
      text_to_image: true,
      image_edit: true,
      aspect_ratios: ["auto", "1:1", "16:9"],
      resolutions: [],
      qualities: [],
      max_images: 4,
      output_formats: ["png", "jpeg", "webp"],
    },
    constraints: [],
  },
  {
    id: "gpt-image-2",
    kind: "image",
    modes: ["text-to-image", "image-edit"],
    pricing: {
      unit: "image",
      from_usd: "0.0060",
      to_usd: "0.2110",
      options: [
        { usd: "0.0060", usd_micros: 6000, resolution: "1K", quality: "low" },
        { usd: "0.2110", usd_micros: 211000, resolution: "1K", quality: "high" },
      ],
    },
    capabilities: {
      text_to_image: true,
      image_edit: true,
      resolutions: ["1K"],
      qualities: ["low", "high"],
      max_images: 4,
    },
  },
  {
    id: "kling-3",
    kind: "video",
    modes: ["text-to-video", "image-to-video"],
    pricing: {
      unit: "second",
      from_usd: "0.1120",
      to_usd: "0.1680",
      options: [
        { usd: "0.1120", usd_micros: 112000, resolution: "1080p", audio: false },
        { usd: "0.1680", usd_micros: 168000, resolution: "1080p", audio: true },
      ],
    },
    capabilities: {
      text_to_video: true,
      image_to_video: true,
      end_frame: true,
      reference_images: false,
      video_to_video: false,
      audio: true,
      resolutions: ["1080p"],
      duration_seconds: { min: 4, max: 15 },
      aspect_ratios: ["16:9", "9:16", "1:1"],
    },
  },
  {
    id: "infinitalk",
    kind: "lipsync",
    modes: ["image-to-lipsync"],
    pricing: {
      unit: "second",
      from_usd: "0.2000",
      to_usd: "0.4000",
      options: [
        { usd: "0.2000", usd_micros: 200000, resolution: "480p" },
        { usd: "0.4000", usd_micros: 400000, resolution: "720p" },
      ],
    },
    capabilities: {
      text_to_video: false,
      image_to_video: true,
      audio: true,
      lipsync: true,
      resolutions: ["480p", "720p"],
      duration_seconds: { min: 2, max: 28 },
      aspect_ratios: [],
    },
    request_fields: {
      prompt: { required: true, type: "string" },
      duration: { required: true, type: "integer", min: 2, max: 28 },
    },
  },
  {
    id: "sume-remix-restyle",
    kind: "video",
    modes: ["restyle"],
    capabilities: { video_to_video: true, routes: ["POST /v1/sume/remix/restyle/v1.0"] },
  },
  {
    id: "veed-dubbing",
    kind: "video",
    modes: ["dubbing"],
    capabilities: { video_to_video: true },
    request_fields: { "dubbing.target_language": { required: true, type: "string" } },
  },
];

export const CATALOG_BODY = { data: { models: CATALOG_MODELS } };

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Reply = Response | (() => Response | Promise<Response>) | Error;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function sumeError(status: number, code: string, message: string, extra = {}): Response {
  return json({ error: { code, message, request_id: "req_test", ...extra } }, status);
}

/**
 * A fetch that answers each `METHOD path` from its queue of replies (the last
 * reply repeats) and records every call. Unknown routes fail the test.
 */
export function fakeSume(routes: Record<string, Reply[]>) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body !== undefined && init.body !== null) {
      body = "<binary>";
    }
    calls.push({ method, url, headers, body });
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}`;
    const queue = routes[key] ?? routes[`${method} ${parsed.origin}${parsed.pathname}`];
    if (!queue || queue.length === 0) throw new Error(`fakeSume: no reply for ${key}`);
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply;
    if (reply instanceof Error) throw reply;
    const res = typeof reply === "function" ? await reply() : reply;
    return res.clone();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function job(
  id: string,
  status: string,
  usage_summary: Record<string, unknown> | null = null,
  extra: Record<string, unknown> = {},
) {
  return { id, type: "video", status, model: "kling-3", usage_summary, ...extra };
}
