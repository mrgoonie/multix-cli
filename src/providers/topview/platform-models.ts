/**
 * TopView API Platform models: a static, verified list (runtime-neutral).
 *
 * Each entry carries the request schema published for that route in
 * https://platform.topview.ai/llms-full.txt ("Native request fields",
 * additionalProperties: false) and the sale price from
 * https://platform.topview.ai/pricing, both checked on `verified_at`.
 * Requests are validated against the schema before anything is sent, so a
 * typo fails locally instead of creating (and billing) a prediction.
 *
 * The catalog warns that inclusion does not mean generation is available, and
 * the platform can change a model at any time: only models listed here can be
 * generated, and prices go stale after MAX_PRICE_AGE_DAYS.
 */

import { ValidationError } from "../../core/errors.js";
import { assertPublicHttpUrl } from "./models.js";

export const PLATFORM_VERIFIED_AT = "2026-10-28";
export const PLATFORM_MODELS_SOURCE = "https://platform.topview.ai/llms-full.txt";
export const PLATFORM_PRICING_SOURCE = "https://platform.topview.ai/pricing";

// ---------------------------------------------------------------------------
// A JSON Schema subset: enough for the published request schemas.

export type Schema =
  | { type: "object"; properties: Record<string, Schema>; required?: string[]; closed?: boolean }
  | { type: "array"; items: Schema; minItems?: number; maxItems?: number }
  | { type: "string"; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "any-object" };

const S = {
  str: (o: { enum?: readonly string[]; minLength?: number; maxLength?: number } = {}): Schema => ({
    type: "string",
    ...o,
  }),
  int: (o: { minimum?: number; maximum?: number } = {}): Schema => ({ type: "integer", ...o }),
  bool: (): Schema => ({ type: "boolean" }),
  anyObj: (): Schema => ({ type: "any-object" }),
  arr: (items: Schema, o: { minItems?: number; maxItems?: number } = {}): Schema => ({
    type: "array",
    items,
    ...o,
  }),
  obj: (properties: Record<string, Schema>, required?: string[]): Schema => ({
    type: "object",
    properties,
    closed: true,
    ...(required ? { required } : {}),
  }),
};

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Validate `value` against `schema`; returns the first problem, or undefined. */
export function schemaError(schema: Schema, value: unknown, path = "body"): string | undefined {
  switch (schema.type) {
    case "object":
    case "any-object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return `${path} must be an object (got ${typeName(value)})`;
      }
      if (schema.type === "any-object") return undefined;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, v] of Object.entries(obj)) {
        const child = schema.properties[key];
        if (!child) {
          if (schema.closed) {
            return `${path}.${key} is not a documented field (allowed: ${Object.keys(schema.properties).join(", ")})`;
          }
          continue;
        }
        if (v === undefined) continue;
        const err = schemaError(child, v, `${path}.${key}`);
        if (err) return err;
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array (got ${typeName(value)})`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} needs at least ${schema.minItems} item(s)`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} allows at most ${schema.maxItems} item(s)`;
      }
      for (let i = 0; i < value.length; i++) {
        const err = schemaError(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
      return undefined;
    }
    case "string": {
      if (typeof value !== "string") return `${path} must be a string (got ${typeName(value)})`;
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of: ${schema.enum.join(", ")} (got ${JSON.stringify(value).slice(0, 40)})`;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must not be empty`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} is longer than ${schema.maxLength} characters`;
      }
      return undefined;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${path} must be an integer (got ${typeName(value)})`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `${path} must be a boolean (got ${typeName(value)})`;
  }
}

// ---------------------------------------------------------------------------
// Published request schemas.

const WAN_MEDIA_TYPES = [
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_video",
  "reference_audio",
  "file",
  "link",
] as const;

const WAN_SCHEMA = S.obj({
  input: S.obj({
    prompt: S.str({ maxLength: 20000 }),
    media: S.arr(S.obj({ type: S.str({ enum: WAN_MEDIA_TYPES }), url: S.str() }, ["type", "url"])),
  }),
  parameters: S.obj({
    resolution: S.str({ enum: ["480P", "720P", "1080P"] }),
    ratio: S.str(),
    duration: S.int(),
    audio: S.bool(),
    seed: S.int(),
    prompt_extend: S.bool(),
    watermark: S.bool(),
  }),
});

/** `{ url }`; other keys pass (the schema declares only "object"). */
const URL_OBJ: Schema = { type: "object", properties: { url: S.str() }, required: ["url"] };
const RATIOS = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

function contentItem(types: readonly string[]): Schema {
  const props: Record<string, Schema> = {
    type: S.str({ enum: types }),
    text: S.str(),
    role: S.str(),
    image_url: URL_OBJ,
    video_url: URL_OBJ,
    audio_url: URL_OBJ,
  };
  if (types.includes("draft_task")) props.draft_task = S.anyObj();
  return S.obj(props, ["type"]);
}

function seedanceSchema(resolutions: readonly string[]): Schema {
  return S.obj(
    {
      content: S.arr(contentItem(["text", "image_url", "video_url", "audio_url", "draft_task"]), {
        minItems: 1,
      }),
      duration: S.int(),
      resolution: S.str({ enum: resolutions }),
      ratio: S.str({ enum: RATIOS }),
      seed: S.int(),
      watermark: S.bool(),
      generate_audio: S.bool(),
      safety_identifier: S.str(),
      return_last_frame: S.bool(),
      service_tier: S.str(),
      execution_expires_after: S.int(),
      priority: S.int(),
      draft: S.bool(),
      camera_fixed: S.bool(),
      output_format: S.str(),
      omni_reference_task_type: S.str(),
      frames: S.int(),
      tools: S.arr(S.anyObj()),
    },
    ["content"],
  );
}

const MINIMAX_SCHEMA = S.obj({
  content: S.arr(contentItem(["text", "image_url", "video_url", "audio_url"])),
  duration: S.int(),
  resolution: S.str({ enum: ["768P", "2K"] }),
  ratio: S.str(),
  aigc_watermark: S.bool(),
});

function t1Schema(ratios: readonly string[]): Schema {
  return S.obj(
    {
      content: S.arr(contentItem(["text", "image_url", "video_url", "audio_url"]), {
        minItems: 1,
        maxItems: 51,
      }),
      duration: S.int(),
      resolution: S.str({ enum: ["720p", "1080p"] }),
      ratio: S.str({ enum: ratios }),
      generate_audio: S.bool(),
    },
    ["content"],
  );
}

const GPT_IMAGE_SCHEMA = S.obj(
  {
    prompt: S.str({ minLength: 1 }),
    size: S.str(),
    resolution: S.str({ enum: ["1k", "2k", "4k"] }),
    quality: S.str({ enum: ["auto", "low", "medium", "high"] }),
    n: S.int({ minimum: 1, maximum: 4 }),
    image_urls: S.arr(S.str(), { maxItems: 16 }),
    mask_url: S.str(),
    output_format: S.str({ enum: ["png", "jpeg", "webp"] }),
    output_compression: S.int({ minimum: 0, maximum: 100 }),
    nsfw_check: S.bool(),
    moderation: S.str({ enum: ["auto", "low"] }),
  },
  ["prompt"],
);

// ---------------------------------------------------------------------------
// Registry.

export type PlatformFamily = "wan" | "seedance" | "minimax" | "t1" | "gpt-image";
export type PlatformTask =
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "text-to-image"
  | "image-edit";

/** USD per billed unit at one resolution (and, for images, one quality). */
export interface PlatformPrice {
  resolution: string;
  quality?: string;
  usd: number;
  /** Lower price per second when the request carries a reference video. */
  refVideoUsd?: number;
}

export interface PlatformModel {
  /** `{vendor}/{model}/{mode}`, the route of the predictions endpoint. */
  id: string;
  vendor: string;
  model: string;
  mode: string;
  family: PlatformFamily;
  task: PlatformTask;
  /** Documented top-level request fields. */
  inputs: string[];
  schema: Schema;
  /** What one price unit buys. */
  unit: "second" | "image";
  prices: PlatformPrice[];
  /** Declared API default resolution; absent when the API declares none. */
  defaultResolution?: string;
  /** Declared API default duration in seconds; absent when the API declares none. */
  defaultDuration?: number;
  /** Allowed duration range in seconds; -1 (automatic) is allowed too where noted. */
  duration?: { min: number; max: number; auto: boolean };
  /** Extra USD per reference image beyond `freeImages` (MiniMax). */
  extraImage?: { usd: number; freeImages: number };
  /** The provider bills measured usage (tokens, output) that the request does not fix. */
  usageBilled: boolean;
  source: string;
  pricing_source: string;
  verified_at: string;
  notes?: string;
}

function inputsOf(schema: Schema): string[] {
  return schema.type === "object" ? Object.keys(schema.properties) : [];
}

function model(
  id: string,
  rest: Omit<
    PlatformModel,
    "id" | "vendor" | "model" | "mode" | "inputs" | "source" | "pricing_source" | "verified_at"
  >,
): PlatformModel {
  const [vendor = "", name = "", mode = ""] = id.split("/");
  return {
    id,
    vendor,
    model: name,
    mode,
    inputs: inputsOf(rest.schema),
    source: PLATFORM_MODELS_SOURCE,
    pricing_source: PLATFORM_PRICING_SOURCE,
    verified_at: PLATFORM_VERIFIED_AT,
    ...rest,
  };
}

const WAN_PRICES: PlatformPrice[] = [
  { resolution: "480P", usd: 0.0416 },
  { resolution: "720P", usd: 0.0832 },
  { resolution: "1080P", usd: 0.1664 },
];

function wan(mode: string, task: PlatformTask): PlatformModel {
  return model(`alibaba/wan-3.0/${mode}`, {
    family: "wan",
    task,
    schema: WAN_SCHEMA,
    unit: "second",
    prices: WAN_PRICES,
    duration: { min: 2, max: 30, auto: true },
    usageBilled: false,
    notes: "No API default for resolution or duration is declared; pass both for a proven cap.",
  });
}

const SEEDANCE: Record<
  string,
  { resolutions: string[]; prices: PlatformPrice[]; maxDuration: number }
> = {
  "seedance-2.5": {
    resolutions: ["480p", "720p", "1080p"],
    prices: [
      { resolution: "480p", usd: 0.0873, refVideoUsd: 0.0522 },
      { resolution: "720p", usd: 0.1965, refVideoUsd: 0.1175 },
      { resolution: "1080p", usd: 0.4833, refVideoUsd: 0.2892 },
    ],
    maxDuration: 30,
  },
  "seedance-2.0": {
    resolutions: ["480p", "720p", "1080p"],
    prices: [
      { resolution: "480p", usd: 0.0571, refVideoUsd: 0.0351 },
      { resolution: "720p", usd: 0.1285, refVideoUsd: 0.0789 },
      { resolution: "1080p", usd: 0.3181, refVideoUsd: 0.1942 },
    ],
    maxDuration: 15,
  },
  "seedance-2.0-fast": {
    resolutions: ["480p", "720p"],
    prices: [
      { resolution: "480p", usd: 0.0457, refVideoUsd: 0.0269 },
      { resolution: "720p", usd: 0.1028, refVideoUsd: 0.0606 },
    ],
    maxDuration: 15,
  },
  "seedance-2.0-mini": {
    resolutions: ["480p", "720p"],
    prices: [
      { resolution: "480p", usd: 0.0286, refVideoUsd: 0.0171 },
      { resolution: "720p", usd: 0.0643, refVideoUsd: 0.0386 },
    ],
    maxDuration: 15,
  },
};

function seedance(name: string, mode: string, task: PlatformTask): PlatformModel {
  const spec = SEEDANCE[name] as (typeof SEEDANCE)[string];
  return model(`bytedance/${name}/${mode}`, {
    family: "seedance",
    task,
    schema: seedanceSchema(spec.resolutions),
    unit: "second",
    prices: spec.prices,
    defaultResolution: "720p",
    defaultDuration: 5,
    duration: { min: 4, max: spec.maxDuration, auto: true },
    usageBilled: true,
    notes: "Prices are estimated for 16:9 at 24 fps; TopView bills the tokens actually used.",
  });
}

const MINIMAX_PRICES: PlatformPrice[] = [
  { resolution: "768P", usd: 0.0648 },
  { resolution: "2K", usd: 0.1036 },
];

function minimax(mode: string, task: PlatformTask): PlatformModel {
  return model(`minimax/minimax-h3/${mode}`, {
    family: "minimax",
    task,
    schema: MINIMAX_SCHEMA,
    unit: "second",
    prices: MINIMAX_PRICES,
    defaultResolution: "768P",
    defaultDuration: 5,
    duration: { min: 4, max: 15, auto: false },
    extraImage: { usd: 0.0259, freeImages: 5 },
    usageBilled: false,
  });
}

function t1(mode: string, task: PlatformTask, omni: boolean): PlatformModel {
  return model(`topview/topview-t1/${mode}`, {
    family: "t1",
    task,
    schema: t1Schema(mode === "image-to-video" ? ["adaptive"] : RATIOS),
    unit: "second",
    prices: omni
      ? [
          { resolution: "720p", usd: 0.1717, refVideoUsd: 0.1027 },
          { resolution: "1080p", usd: 0.4224, refVideoUsd: 0.2527 },
        ]
      : [
          { resolution: "720p", usd: 0.1649, refVideoUsd: 0.0986 },
          { resolution: "1080p", usd: 0.4056, refVideoUsd: 0.2427 },
        ],
    defaultResolution: "720p",
    defaultDuration: 5,
    duration: { min: 4, max: 30, auto: true },
    usageBilled: false,
    notes: "With a reference video, its input seconds are billed on top of the output seconds.",
  });
}

const GPT_IMAGE_PRICES: PlatformPrice[] = [
  { quality: "low", resolution: "1k", usd: 0.0049 },
  { quality: "low", resolution: "2k", usd: 0.0179 },
  { quality: "low", resolution: "4k", usd: 0.0499 },
  { quality: "medium", resolution: "1k", usd: 0.0232 },
  { quality: "medium", resolution: "2k", usd: 0.0912 },
  { quality: "medium", resolution: "4k", usd: 0.3432 },
  { quality: "high", resolution: "1k", usd: 0.0848 },
  { quality: "high", resolution: "2k", usd: 0.3377 },
  { quality: "high", resolution: "4k", usd: 1.3293 },
];

function gptImage(mode: string, task: PlatformTask): PlatformModel {
  return model(`openai/gpt-image-2/${mode}`, {
    family: "gpt-image",
    task,
    schema: GPT_IMAGE_SCHEMA,
    unit: "image",
    prices: GPT_IMAGE_PRICES,
    usageBilled: true,
    notes:
      "Prices are an estimated average; TopView bills actual usage. A pixel size (WxH) is billed as 4k and quality auto as high.",
  });
}

export const PLATFORM_MODELS: readonly PlatformModel[] = [
  wan("text-to-video", "text-to-video"),
  wan("image-to-video", "image-to-video"),
  wan("reference-to-video", "reference-to-video"),
  ...Object.keys(SEEDANCE).flatMap((name) => [
    seedance(name, "text-to-video", "text-to-video"),
    seedance(name, "image-to-video", "image-to-video"),
    seedance(name, "omni-reference-to-video", "reference-to-video"),
  ]),
  minimax("text-to-video", "text-to-video"),
  minimax("image-to-video", "image-to-video"),
  t1("text-to-video", "text-to-video", false),
  t1("image-to-video", "image-to-video", false),
  t1("omni-reference-to-video", "reference-to-video", true),
  gptImage("text-to-image", "text-to-image"),
  gptImage("edit", "image-edit"),
];

export function findPlatformModel(id: string): PlatformModel | undefined {
  const key = id.trim().replace(/^\/+|\/+$/g, "");
  return PLATFORM_MODELS.find((m) => m.id === key);
}

export function requirePlatformModel(id: string): PlatformModel {
  const spec = findPlatformModel(id);
  if (!spec) {
    throw new ValidationError(
      `Unknown TopView platform model "${id}". Use one of: ${PLATFORM_MODELS.map((m) => m.id).join(", ")} (see \`multix topview models\`)`,
    );
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Request building.

export interface PlatformFlags {
  prompt?: string;
  /** Image URLs (local files are uploaded by the caller first). */
  images?: string[];
  /** Parsed --input JSON: the base body. */
  input?: Record<string, unknown>;
  duration?: number;
  resolution?: string;
  ratio?: string;
}

type Body = Record<string, unknown>;

function asObject(value: unknown, path: string): Body {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`--input ${path} must be a JSON object`);
  }
  return { ...(value as Body) };
}

/** Set `key` from a flag; fail when --input already set it to something else. */
function put(target: Body, key: string, value: unknown, flag: string): void {
  if (value === undefined) return;
  if (target[key] !== undefined && JSON.stringify(target[key]) !== JSON.stringify(value)) {
    throw new ValidationError(`${flag} conflicts with "${key}" in --input; set it in one place`);
  }
  target[key] = value;
}

function contentRole(spec: PlatformModel, index: number): string {
  if (spec.task === "image-to-video") return index === 0 ? "first_frame" : "last_frame";
  return "reference_image";
}

function checkImageCount(spec: PlatformModel, count: number): void {
  if (count === 0) return;
  if (spec.task === "text-to-video" || spec.task === "text-to-image") {
    throw new ValidationError(
      `${spec.id} takes no --image; use the image-to-video, reference or edit mode instead`,
    );
  }
  if (spec.task === "image-to-video" && count > 2) {
    throw new ValidationError(
      `${spec.id} takes at most 2 --image values (first frame, then last frame)`,
    );
  }
}

/**
 * Build the request body: --input is the base, and --prompt, --image,
 * --duration, --resolution and --ratio fill in the model's own fields. A flag
 * that contradicts --input is an error, never silently overridden.
 */
export function buildPlatformBody(spec: PlatformModel, flags: PlatformFlags): Body {
  const body: Body = { ...(flags.input ?? {}) };
  const images = flags.images ?? [];
  checkImageCount(spec, images.length);

  switch (spec.family) {
    case "wan": {
      const input = asObject(body.input, "input");
      put(input, "prompt", flags.prompt, "--prompt");
      if (images.length > 0) {
        const media = Array.isArray(input.media) ? [...input.media] : [];
        images.forEach((url, i) => {
          media.push({ type: contentRole(spec, i), url });
        });
        input.media = media;
      }
      if (Object.keys(input).length > 0) body.input = input;
      const params = asObject(body.parameters, "parameters");
      put(params, "duration", flags.duration, "--duration");
      put(params, "resolution", flags.resolution, "--resolution");
      put(params, "ratio", flags.ratio, "--ratio");
      if (Object.keys(params).length > 0) body.parameters = params;
      break;
    }
    case "seedance":
    case "minimax":
    case "t1": {
      const content = Array.isArray(body.content) ? [...body.content] : [];
      if (flags.prompt !== undefined) {
        if (content.some((c) => (c as Body | null)?.type === "text")) {
          throw new ValidationError('--prompt conflicts with a "text" item in --input content');
        }
        content.unshift({ type: "text", text: flags.prompt });
      }
      images.forEach((url, i) => {
        content.push({ type: "image_url", role: contentRole(spec, i), image_url: { url } });
      });
      if (content.length > 0 || body.content !== undefined) body.content = content;
      put(body, "duration", flags.duration, "--duration");
      put(body, "resolution", flags.resolution, "--resolution");
      put(body, "ratio", flags.ratio, "--ratio");
      break;
    }
    case "gpt-image": {
      put(body, "prompt", flags.prompt, "--prompt");
      if (images.length > 0) {
        const urls = Array.isArray(body.image_urls) ? [...body.image_urls] : [];
        body.image_urls = [...urls, ...images];
      }
      if (flags.duration !== undefined) {
        throw new ValidationError(`${spec.id} makes images; --duration does not apply`);
      }
      if (flags.ratio !== undefined) {
        throw new ValidationError(
          `${spec.id} has no ratio field; set "size" in --input (e.g. {"size":"1536x1024"})`,
        );
      }
      put(body, "resolution", flags.resolution, "--resolution");
      break;
    }
  }
  return body;
}

/** Every URL a body sends to TopView, with its JSON path. */
export function bodyUrls(spec: PlatformModel, body: Body): { path: string; url: unknown }[] {
  const urls: { path: string; url: unknown }[] = [];
  if (spec.family === "wan") {
    const media = (body.input as Body | undefined)?.media;
    if (Array.isArray(media)) {
      media.forEach((m, i) => {
        urls.push({ path: `input.media[${i}].url`, url: (m as Body | null)?.url });
      });
    }
  } else if (spec.family === "gpt-image") {
    if (Array.isArray(body.image_urls)) {
      body.image_urls.forEach((u, i) => {
        urls.push({ path: `image_urls[${i}]`, url: u });
      });
    }
    if (body.mask_url !== undefined) urls.push({ path: "mask_url", url: body.mask_url });
  } else if (Array.isArray(body.content)) {
    body.content.forEach((c, i) => {
      for (const key of ["image_url", "video_url", "audio_url"]) {
        const ref = (c as Body | null)?.[key] as Body | undefined;
        if (ref !== undefined) urls.push({ path: `content[${i}].${key}.url`, url: ref?.url });
      }
    });
  }
  return urls;
}

/** Media counts by kind, for limits and pricing. */
export function mediaCounts(
  spec: PlatformModel,
  body: Body,
): {
  images: number;
  videos: number;
  audios: number;
  firstFrames: number;
} {
  const counts = { images: 0, videos: 0, audios: 0, firstFrames: 0 };
  if (spec.family === "wan") {
    const media = (body.input as Body | undefined)?.media;
    for (const m of Array.isArray(media) ? media : []) {
      const type = (m as Body | null)?.type;
      if (type === "first_frame") counts.firstFrames++;
      if (type === "first_frame" || type === "last_frame" || type === "reference_image") {
        counts.images++;
      } else if (type === "reference_video") counts.videos++;
      else if (type === "reference_audio") counts.audios++;
    }
  } else if (spec.family === "gpt-image") {
    counts.images = Array.isArray(body.image_urls) ? body.image_urls.length : 0;
  } else {
    for (const c of Array.isArray(body.content) ? body.content : []) {
      const item = c as Body | null;
      if (item?.type === "image_url") {
        counts.images++;
        if (item.role === "first_frame") counts.firstFrames++;
      } else if (item?.type === "video_url") counts.videos++;
      else if (item?.type === "audio_url") counts.audios++;
    }
  }
  return counts;
}

function hasText(spec: PlatformModel, body: Body): boolean {
  if (spec.family === "wan") {
    const prompt = (body.input as Body | undefined)?.prompt;
    return typeof prompt === "string" && prompt.trim() !== "";
  }
  if (spec.family === "gpt-image") return typeof body.prompt === "string";
  return (Array.isArray(body.content) ? body.content : []).some(
    (c) => (c as Body | null)?.type === "text",
  );
}

/** The duration field of a body, wherever the family keeps it. */
export function bodyDuration(spec: PlatformModel, body: Body): unknown {
  return spec.family === "wan" ? (body.parameters as Body | undefined)?.duration : body.duration;
}

export function bodyResolution(spec: PlatformModel, body: Body): unknown {
  return spec.family === "wan"
    ? (body.parameters as Body | undefined)?.resolution
    : body.resolution;
}

/**
 * Validate a body before it is sent: the published schema first, then the
 * documented per-mode rules (duration range, required frames and references,
 * media limits) and every URL (public http(s) only).
 */
export function validatePlatformBody(spec: PlatformModel, body: Body): void {
  const err = schemaError(spec.schema, body);
  if (err) throw new ValidationError(`Invalid request for ${spec.id}: ${err}`);

  const duration = bodyDuration(spec, body);
  if (typeof duration === "number" && spec.duration) {
    const { min, max, auto } = spec.duration;
    if (!(duration === -1 && auto) && (duration < min || duration > max)) {
      throw new ValidationError(
        `Duration for ${spec.id} must be ${min}-${max} seconds${auto ? " or -1 (automatic)" : ""}`,
      );
    }
  }

  const counts = mediaCounts(spec, body);
  if (spec.family !== "gpt-image" && !hasText(spec, body) && spec.task === "text-to-video") {
    throw new ValidationError(`${spec.id} needs a prompt (--prompt)`);
  }
  if (spec.family === "gpt-image" && spec.task === "image-edit" && counts.images === 0) {
    throw new ValidationError(`${spec.id} needs at least one --image to edit`);
  }
  if (spec.task === "image-to-video" && counts.firstFrames === 0) {
    throw new ValidationError(`${spec.id} needs a first-frame image (--image)`);
  }
  if (spec.task === "reference-to-video" && counts.images + counts.videos + counts.audios === 0) {
    throw new ValidationError(`${spec.id} needs at least one reference (--image or --input media)`);
  }
  if (spec.family === "seedance" && spec.task === "reference-to-video") {
    const full = spec.model === "seedance-2.5" || spec.model === "seedance-2.0";
    if (full && counts.videos === 0) {
      throw new ValidationError(`${spec.id} needs at least one reference video in --input content`);
    }
    const limits =
      spec.model === "seedance-2.5"
        ? { videos: 10, images: 30, audios: 10 }
        : { videos: 3, images: 9, audios: 3 };
    if (
      counts.videos > limits.videos ||
      counts.images > limits.images ||
      counts.audios > limits.audios
    ) {
      throw new ValidationError(
        `${spec.id} allows at most ${limits.images} images, ${limits.videos} videos and ${limits.audios} audios`,
      );
    }
  }
  if (spec.family === "wan" && spec.task === "reference-to-video") {
    if (counts.videos > 5 || counts.images > 10 || counts.audios > 5) {
      throw new ValidationError(`${spec.id} allows at most 10 images, 5 videos and 5 audios`);
    }
  }
  if (spec.family === "t1" && (counts.images > 30 || counts.videos > 10 || counts.audios > 10)) {
    throw new ValidationError(`${spec.id} allows at most 30 images, 10 videos and 10 audios`);
  }
  if (spec.family === "minimax" && counts.images === 0 && counts.videos === 0) {
    if (typeof body.ratio !== "string" || body.ratio === "adaptive") {
      throw new ValidationError(`${spec.id} without an image needs --ratio (not adaptive)`);
    }
  }

  for (const { path, url } of bodyUrls(spec, body)) {
    if (typeof url !== "string") {
      throw new ValidationError(`Invalid request for ${spec.id}: body.${path} must be a URL`);
    }
    assertPublicHttpUrl(url, `body.${path}`);
  }
}
