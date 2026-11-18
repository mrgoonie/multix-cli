/**
 * Build a ToAPIs generation body from common options. ToAPIs keeps each
 * upstream model's own field names, so the aspect ratio, resolution, audio
 * switch and reference images land in different fields per model family
 * (https://docs.toapis.com, per-model "generation" pages, read 2026-11-18).
 * Anything not mapped here can be sent with `extra` (CLI `--param k=v`).
 * Runtime-neutral: no node:* imports.
 */

import { ValidationError } from "../../core/errors.js";
import type { ToapisMediaKind } from "./types.js";

export interface ToapisBodyOptions {
  kind: ToapisMediaKind;
  model: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  count?: number;
  audio?: boolean;
  seed?: number;
  negativePrompt?: string;
  /** Public URLs of reference images (upload local files first). */
  images?: string[];
  firstFrame?: string;
  lastFrame?: string;
  /** Raw fields merged last; a dotted key such as `metadata.watermark` sets a nested field. */
  extra?: Record<string, unknown>;
}

type Body = Record<string, unknown>;

const lower = (m: string) => m.toLowerCase();
const isSeedance = (m: string) => /^seedance-2/.test(lower(m)) && !/-ext$/.test(lower(m));
const isSeedanceExt = (m: string) => /^seedance-.*-ext$/.test(lower(m));
const isVeoOfficial = (m: string) => /^veo3\.1-.*-official$/.test(lower(m));
const isVeoReseller = (m: string) => /^veo3\.1-(fast|lite)$/.test(lower(m));
const isKlingMode = (m: string) => /^kling-v(3|2-6)$/.test(lower(m));
const isWan3 = (m: string) => /^wan3\.0/.test(lower(m));
const isGeminiPreview = (m: string) => /^gemini-.*-image-preview$/.test(lower(m));
/** Image families whose resolution goes in `metadata.resolution`, upper-case (1K/2K/4K). */
const metadataResolutionImage = (m: string) =>
  /^(gemini-|doubao-seedream|flux-2)/.test(lower(m)) && !/^gpt-/.test(lower(m));
/** Families that take the aspect ratio in `size`. */
const aspectInSize = (m: string, kind: ToapisMediaKind) =>
  (kind === "image" && !/^grok-image/.test(lower(m))) || isVeoOfficial(m) || isSeedanceExt(m);

/**
 * Fields the cost preflight prices from named flags. Setting them through
 * `--param` would charge for a run other than the one priced.
 */
const PRICED_FIELDS = new Set([
  "model",
  "prompt",
  "n",
  "duration",
  "seconds",
  "resolution",
  "mode",
  "metadata.resolution",
]);

function setPath(body: Body, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = body;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) node[part] = {};
    node = node[part] as Body;
  }
  node[parts[parts.length - 1] as string] = value;
}

function klingMode(resolution: string): string {
  const r = lower(resolution);
  if (r === "std" || r === "pro") return r;
  if (r === "1080p") return "pro";
  if (r === "720p") return "std";
  throw new ValidationError(`${resolution} is not a Kling v3/v2.6 resolution; use 720p or 1080p`);
}

function imageResolution(model: string, resolution: string): string {
  // gpt-image documents lower-case 1k/2k/4k; the metadata families use 1K/2K/4K.
  return metadataResolutionImage(model) ? resolution.toUpperCase() : lower(resolution);
}

function putImages(body: Body, opts: ToapisBodyOptions): void {
  const { model } = opts;
  const images = opts.images ?? [];
  const framed = Boolean(opts.firstFrame || opts.lastFrame);

  if (isSeedance(model) || (opts.kind === "video" && /^kling-(v3|v2-6|4\.0)/.test(lower(model)))) {
    const roles: Array<{ url: string; role: string }> = [];
    if (opts.firstFrame) roles.push({ url: opts.firstFrame, role: "first_frame" });
    if (opts.lastFrame) roles.push({ url: opts.lastFrame, role: "last_frame" });
    for (const url of images) roles.push({ url, role: "reference_image" });
    if (framed && images.length > 0 && isSeedance(model)) {
      throw new ValidationError(
        "Seedance takes first/last frames or reference images, not both in one request",
      );
    }
    if (roles.length > 0) body.image_with_roles = roles;
    return;
  }

  const all = [opts.firstFrame, ...images].filter((u): u is string => Boolean(u));
  if (opts.lastFrame) {
    if (isVeoOfficial(model)) setPath(body, "metadata.lastFrame", opts.lastFrame);
    else all.push(opts.lastFrame);
  }
  if (all.length === 0) return;
  if (isGeminiPreview(model)) body.image_urls = all.map((url) => ({ url }));
  else if (/^gpt-image/.test(lower(model)) && !/official$/.test(lower(model))) {
    body.reference_images = all;
  } else body.image_urls = all;
}

export function buildToapisBody(opts: ToapisBodyOptions): Body {
  const { model, kind } = opts;
  if (!model.trim()) throw new ValidationError("A ToAPIs model id is required");
  if (!opts.prompt.trim()) throw new ValidationError("A prompt is required");
  const body: Body = { model, prompt: opts.prompt };

  if (opts.aspectRatio) {
    const key = aspectInSize(model, kind) ? "size" : isWan3(model) ? "ratio" : "aspect_ratio";
    body[key] = opts.aspectRatio;
  }

  if (opts.resolution) {
    if (kind === "image") {
      const value = imageResolution(model, opts.resolution);
      if (metadataResolutionImage(model)) setPath(body, "metadata.resolution", value);
      else body.resolution = value;
    } else if (isKlingMode(model)) body.mode = klingMode(opts.resolution);
    else if (isVeoReseller(model)) setPath(body, "metadata.resolution", lower(opts.resolution));
    else body.resolution = lower(opts.resolution);
  }

  // Seedance's own default is not documented; send the 720p the estimate prices.
  if (!opts.resolution && kind === "video" && isSeedance(model)) body.resolution = "720p";

  if (opts.duration !== undefined)
    body[isSeedanceExt(model) ? "seconds" : "duration"] = opts.duration;
  if (opts.count !== undefined) body.n = opts.count;
  if (opts.seed !== undefined) body.seed = opts.seed;

  if (opts.audio !== undefined) {
    if (isVeoOfficial(model)) setPath(body, "metadata.generateAudio", opts.audio);
    else if (isKlingMode(model) || /^wan2\.6/.test(lower(model))) body.audio = opts.audio;
    else body.generate_audio = opts.audio;
  }

  if (opts.negativePrompt) {
    if (isVeoOfficial(model)) setPath(body, "metadata.negativePrompt", opts.negativePrompt);
    else if (isKlingMode(model)) setPath(body, "metadata.negative_prompt", opts.negativePrompt);
    else body.negative_prompt = opts.negativePrompt;
  }

  putImages(body, opts);

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (PRICED_FIELDS.has(key)) {
      throw new ValidationError(
        `--param ${key} is priced; use the matching flag (--model, --count, --duration, --resolution) instead`,
      );
    }
    setPath(body, key, value);
  }
  return body;
}

/** Parse `key=value` pairs; a value that parses as JSON (numbers, booleans, arrays) is used as such. */
export function parseParams(pairs: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new ValidationError(`--param needs key=value, got "${pair}"`);
    const raw = pair.slice(at + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // Plain string.
    }
    out[pair.slice(0, at).trim()] = value;
  }
  return out;
}
