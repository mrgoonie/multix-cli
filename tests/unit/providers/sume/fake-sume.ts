/**
 * In-memory fake of the Sume HTTP API for offline tests.
 * Routes are matched by "METHOD /path" (path relative to BASE, or the full URL
 * for other hosts); each route holds a queue of responses, and the last one
 * repeats once drained. Catalog rows are trimmed copies of real ones.
 */

export const BASE = "https://sume.test";
export const KEY = "sk_sume_TESTsecret1234567890abcdef";
export const JOB_ID = "job_0f0e0d0c-1111-4222-8333-444455556666";
export const ARTIFACT_URL = "https://media.sume.test/artifacts/artf_1/out.png?sig=SIGNED_TOKEN_123";
export const UPLOAD_URL = "https://uploads.sume.test/put/asset_1?sig=UPLOAD_SIGNATURE_456";
export const PUBLIC_URL = "https://media.sume.test/inputs/asset_1.png";

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
    calls.push({ method, url, headers, body, rawBody: init.body ?? null });

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

export const noSleep = async () => {};

export function sumeError(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, request_id: "req_123", ...(details ? { details } : {}) } };
}

export function submitted(extra: Record<string, unknown> = {}) {
  return {
    data: {
      request_id: JOB_ID,
      job: { id: JOB_ID, status: "queued", model: "nano-banana-2.1" },
      cancelable: true,
      next_poll_after_seconds: 2,
      terminal: false,
      idempotency_hit: false,
      usage: { credits: 35, usd: "0.35" },
      ...extra,
    },
  };
}

export function status(sumeStatus: string, extra: Record<string, unknown> = {}) {
  const terminal = ["completed", "failed", "canceled"].includes(sumeStatus);
  return {
    data: {
      request_id: JOB_ID,
      job_id: JOB_ID,
      status: sumeStatus.toUpperCase(),
      sume_status: sumeStatus,
      terminal,
      result_ready: sumeStatus === "completed",
      cancelable: sumeStatus === "queued",
      next_poll_after_seconds: terminal ? null : 2,
      ...extra,
    },
  };
}

export function result(urls: string[] = [ARTIFACT_URL]) {
  return {
    data: {
      request_id: JOB_ID,
      job_id: JOB_ID,
      status: "COMPLETED",
      result: {
        artifacts: urls.map((url, i) => ({
          id: `artf_${i + 1}`,
          type: "image",
          url,
          content_type: "image/png",
        })),
      },
    },
  };
}

export const NANO = {
  id: "nano-banana-2.1",
  kind: "image",
  modes: ["text-to-image", "image-edit"],
  capabilities: {
    text_to_image: true,
    image_edit: true,
    aspect_ratios: ["auto", "16:9", "1:1", "9:16"],
    resolutions: ["1K", "2K", "4K"],
    qualities: [],
    max_images: 4,
    output_formats: ["png", "jpeg", "webp"],
  },
  request_fields: null,
  pricing: {
    currency: "USD",
    unit: "image",
    from_usd: "0.0336",
    options: [
      { label: "1K", usd: "0.0336", usd_micros: 33600, route: "r1", resolution: "1K" },
      { label: "2K", usd: "0.0504", usd_micros: 50400, route: "r1", resolution: "2K" },
      { label: "4K", usd: "0.1134", usd_micros: 113400, route: "r1", resolution: "4K" },
    ],
    to_usd: "0.1134",
  },
  constraints: [],
};

export const SEEDREAM = {
  id: "seedream-4-5-edit",
  kind: "image",
  modes: ["text-to-image", "image-edit"],
  capabilities: {
    text_to_image: true,
    image_edit: true,
    aspect_ratios: ["1:1", "16:9"],
    resolutions: [],
    qualities: [],
    max_images: 4,
    output_formats: ["png", "jpeg", "webp"],
  },
  request_fields: null,
  pricing: {
    currency: "USD",
    unit: "image",
    options: [{ label: "per image", usd: "0.0385", usd_micros: 38500, route: "r2" }],
  },
  constraints: [],
};

export const LAYERED = {
  id: "qwen-image-layered",
  kind: "image",
  modes: ["image-edit"],
  capabilities: {
    text_to_image: false,
    image_edit: true,
    aspect_ratios: [],
    resolutions: [],
    qualities: [],
    max_images: 10,
    output_formats: ["png"],
  },
  request_fields: {
    image_urls: { required: true, description: "The one image to split into layers (HTTPS)." },
    num_images: {
      required: true,
      description: "Layers to make, 2-10.",
      min: 2,
      max: 10,
      default: 2,
    },
  },
  pricing: {
    currency: "USD",
    unit: "image",
    options: [{ label: "per image", usd: "0.0500", usd_micros: 50000, route: "r3" }],
  },
  constraints: [],
};

export const VEO = {
  id: "veo-3.1",
  kind: "video",
  modes: ["text-to-video"],
  capabilities: {
    text_to_video: true,
    image_to_video: false,
    end_frame: false,
    reference_images: false,
    video_to_video: false,
    audio: true,
    resolutions: ["720p", "1080p"],
    duration_seconds: { min: 4, max: 8 },
    duration_values: [4, 6, 8],
    aspect_ratios: ["16:9", "9:16"],
  },
  request_fields: null,
  pricing: {
    currency: "USD",
    unit: "second",
    options: [
      {
        label: "720p · audio off",
        usd: "0.2000",
        usd_micros: 200000,
        resolution: "720p",
        audio: false,
      },
      {
        label: "720p · audio on",
        usd: "0.4000",
        usd_micros: 400000,
        resolution: "720p",
        audio: true,
      },
      {
        label: "1080p · audio off",
        usd: "0.2000",
        usd_micros: 200000,
        resolution: "1080p",
        audio: false,
      },
      {
        label: "1080p · audio on",
        usd: "0.4000",
        usd_micros: 400000,
        resolution: "1080p",
        audio: true,
      },
    ],
  },
  constraints: [],
};

export const SEEDANCE = {
  id: "seedance-2",
  kind: "video",
  modes: ["text-to-video", "image-to-video", "reference-to-video"],
  capabilities: {
    text_to_video: true,
    image_to_video: true,
    end_frame: true,
    reference_images: true,
    video_to_video: false,
    audio: true,
    resolutions: ["480p", "720p", "1080p"],
    duration_seconds: { min: 4, max: 15 },
    max_reference_images: 2,
    aspect_ratios: ["16:9", "9:16"],
  },
  request_fields: null,
  pricing: {
    currency: "USD",
    unit: "second",
    options: [
      { label: "480p", usd: "0.0711", usd_micros: 71100, resolution: "480p" },
      { label: "720p", usd: "0.1538", usd_micros: 153800, resolution: "720p" },
      { label: "1080p", usd: "0.3846", usd_micros: 384600, resolution: "1080p" },
    ],
  },
  constraints: [],
};

export const AVATAR = {
  id: "kling-avatar-2.0",
  kind: "lipsync",
  modes: ["image-to-lipsync"],
  capabilities: {
    text_to_video: false,
    image_to_video: true,
    lipsync: true,
    audio: true,
    resolutions: [],
    duration_seconds: { min: 2, max: 60 },
    aspect_ratios: [],
  },
  request_fields: {
    prompt: { required: false, type: "string", description: "The scene around the speaker." },
    duration: {
      required: true,
      type: "integer",
      description: "The audio's length in whole seconds.",
      min: 2,
      max: 60,
    },
  },
  pricing: {
    currency: "USD",
    unit: "second",
    options: [{ label: "per second", usd: "0.0560", usd_micros: 56000 }],
  },
  constraints: [],
};

export const RESTYLE = {
  id: "sume-remix-restyle",
  kind: "video",
  modes: ["restyle"],
  capabilities: {
    video_to_video: true,
    routes: ["POST /v1/sume/remix/restyle/v1.0"],
    duration_seconds: { min: 4, max: 15 },
  },
  request_fields: {
    preset_id: { required: true, type: "string", options: ["comic-3d"] },
    video_url: { required: true, media: "video" },
  },
  pricing: {
    currency: "USD",
    unit: "second",
    options: [{ label: "720p", usd: "0.2766", usd_micros: 276600, resolution: "720p" }],
  },
  constraints: [],
};

/** A caption model with a dotted request field (`captions.style`) for --param. */
export const CAPTIONS = {
  id: "veed-subtitles",
  kind: "captions",
  modes: ["video-captions"],
  capabilities: { captions: true, video_to_video: true, duration_seconds: { min: 2, max: 600 } },
  request_fields: {
    video_url: { required: true, media: "video" },
    duration: { required: true, type: "integer", min: 2, max: 600 },
    "captions.style": { required: false, type: "string", options: ["classic", "bold"] },
    "captions.max_words": { required: false, type: "integer", min: 1, max: 10 },
    prompt: { omit: true },
  },
  pricing: {
    currency: "USD",
    unit: "second",
    options: [{ label: "1080p", usd: "0.001667", usd_micros: 1667, resolution: "1080p" }],
  },
  constraints: [],
};

export const ROWS = [NANO, SEEDREAM, LAYERED, VEO, SEEDANCE, AVATAR, RESTYLE, CAPTIONS];

export function catalogBody(rows: unknown[] = ROWS) {
  return { data: { currency: "USD", models: rows } };
}
