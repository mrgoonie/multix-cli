/**
 * Build a generate body from command options and check it against the
 * model's catalog entry (runtime-neutral). A field is sent only when the
 * catalog confirms the model takes it; anything else is refused before a
 * request leaves, so no paid job starts on a body the model would reject.
 */

import { ValidationError } from "../../core/errors.js";
import type { SumeCapabilities, SumeCatalogModel } from "./types.js";

export interface SumeImageInput {
  prompt?: string;
  /** Edit sources: https URLs or local paths (uploaded by the command layer). */
  images?: string[];
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  numImages?: number;
  outputFormat?: string;
}

export interface SumeVideoInput {
  prompt?: string;
  image?: string;
  endImage?: string;
  refImages?: string[];
  refVideos?: string[];
  refAudios?: string[];
  video?: string;
  audio?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
}

/** Body fields that carry media references (single URL or list of URLs). */
export const MEDIA_FIELDS = [
  "image_urls",
  "image_url",
  "end_image_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "video_url",
  "audio_url",
] as const;

/** Documented: image_urls takes 1-16 URLs. */
const MAX_IMAGE_URLS = 16;

/** The flag that sets each body field, for messages. */
const FLAG_FOR: Record<string, string> = {
  prompt: "a prompt",
  image_urls: "--image",
  image_url: "--image",
  end_image_url: "--end-image",
  reference_image_urls: "--ref-image",
  reference_video_urls: "--ref-video",
  reference_audio_urls: "--ref-audio",
  video_url: "--video",
  audio_url: "--audio",
  duration: "--duration",
  resolution: "--resolution",
  aspect_ratio: "--aspect-ratio",
  generate_audio: "--generate-audio",
  num_images: "--num-images",
  quality: "--quality",
  output_format: "--output-format",
};

function refuse(model: SumeCatalogModel, what: string): never {
  throw new ValidationError(
    `Sume model ${model.id} does not take ${what} according to its catalog entry. See: multix sume models --model ${model.id}`,
  );
}

function oneOf(
  model: SumeCatalogModel,
  value: string | undefined,
  allowed: unknown,
  flag: string,
): void {
  if (value === undefined) return;
  const list = Array.isArray(allowed)
    ? allowed.filter((v): v is string => typeof v === "string")
    : [];
  if (list.length === 0) refuse(model, flag);
  if (!list.includes(value)) {
    throw new ValidationError(
      `${flag} for ${model.id} must be one of ${list.join(", ")} (got "${value}")`,
    );
  }
}

function needs(model: SumeCatalogModel, flag: keyof SumeCapabilities, label: string): void {
  if (model.capabilities?.[flag] !== true) refuse(model, label);
}

/** Required or refused fields the catalog's `request_fields` name. */
function checkRequestFields(model: SumeCatalogModel, body: Record<string, unknown>): void {
  for (const [name, field] of Object.entries(model.request_fields ?? {})) {
    if (!field || typeof field !== "object") continue;
    const flag = FLAG_FOR[name];
    const present = body[name] !== undefined;
    if (field.omit === true && present) refuse(model, flag ?? name);
    if (field.required === true && !present) {
      throw new ValidationError(
        flag
          ? `Sume model ${model.id} requires ${flag}.`
          : `Sume model ${model.id} requires the field "${name}", which multix does not support (schema mismatch); nothing was sent.`,
      );
    }
    if (present && typeof body[name] === "number") {
      const n = body[name] as number;
      if (
        (field.min !== undefined && n < field.min) ||
        (field.max !== undefined && n > field.max)
      ) {
        throw new ValidationError(
          `${flag ?? name} for ${model.id} must be between ${field.min ?? "-"} and ${field.max ?? "-"} (got ${n})`,
        );
      }
    }
  }
}

function setIf(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  body[key] = value;
}

export function buildImageBody(
  model: SumeCatalogModel,
  input: SumeImageInput,
): Record<string, unknown> {
  const c = model.capabilities ?? {};
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ValidationError("A prompt is required for sume image");
  const images = input.images ?? [];
  if (images.length > 0) needs(model, "image_edit", "--image (image edit)");
  else needs(model, "text_to_image", "text-to-image (give --image to edit)");
  if (images.length > MAX_IMAGE_URLS) {
    throw new ValidationError(
      `--image takes at most ${MAX_IMAGE_URLS} images (got ${images.length})`,
    );
  }
  oneOf(model, input.aspectRatio, c.aspect_ratios, "--aspect-ratio");
  oneOf(model, input.resolution, c.resolutions, "--resolution");
  oneOf(model, input.quality, c.qualities, "--quality");
  oneOf(model, input.outputFormat, c.output_formats, "--output-format");
  if (input.numImages !== undefined) {
    const max = typeof c.max_images === "number" ? c.max_images : 1;
    if (!Number.isInteger(input.numImages) || input.numImages < 1 || input.numImages > max) {
      throw new ValidationError(`--num-images for ${model.id} must be an integer from 1 to ${max}`);
    }
  }
  const body: Record<string, unknown> = { model: model.id, prompt };
  setIf(body, "image_urls", images);
  setIf(body, "aspect_ratio", input.aspectRatio);
  setIf(body, "resolution", input.resolution);
  setIf(body, "quality", input.quality);
  setIf(body, "num_images", input.numImages);
  setIf(body, "output_format", input.outputFormat);
  checkRequestFields(model, body);
  return body;
}

function checkDuration(model: SumeCatalogModel, seconds: number | undefined): void {
  if (seconds === undefined) return;
  const c = model.capabilities ?? {};
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ValidationError(`--duration must be a positive number of seconds (got ${seconds})`);
  }
  const values = Array.isArray(c.duration_values) ? c.duration_values : [];
  if (values.length > 0) {
    if (!values.includes(seconds)) {
      throw new ValidationError(
        `--duration for ${model.id} must be one of ${values.join(", ")} (got ${seconds})`,
      );
    }
    return;
  }
  const range = c.duration_seconds;
  if (!range || (range.min === undefined && range.max === undefined)) refuse(model, "--duration");
  if (
    (range.min !== undefined && seconds < range.min) ||
    (range.max !== undefined && seconds > range.max)
  ) {
    throw new ValidationError(
      `--duration for ${model.id} must be ${range.min ?? 0}-${range.max ?? "any"} seconds (got ${seconds})`,
    );
  }
}

export function buildVideoBody(
  model: SumeCatalogModel,
  input: SumeVideoInput,
): Record<string, unknown> {
  const c = model.capabilities ?? {};
  const refImages = input.refImages ?? [];
  const refVideos = input.refVideos ?? [];
  const refAudios = input.refAudios ?? [];
  if (input.image !== undefined) needs(model, "image_to_video", "--image (image-to-video)");
  if (input.endImage !== undefined) needs(model, "end_frame", "--end-image (end frame)");
  if (refImages.length > 0) needs(model, "reference_images", "--ref-image (reference images)");
  if (refVideos.length > 0) needs(model, "reference_videos", "--ref-video (reference videos)");
  if (refAudios.length > 0) needs(model, "reference_audios", "--ref-audio (reference audio)");
  if (input.video !== undefined) needs(model, "video_to_video", "--video (source video)");
  if (input.audio !== undefined) needs(model, "lipsync", "--audio (lipsync audio track)");
  if (input.generateAudio !== undefined && (model.kind !== "video" || c.audio !== true)) {
    refuse(model, "--generate-audio");
  }
  if (typeof c.max_reference_images === "number" && refImages.length > c.max_reference_images) {
    throw new ValidationError(
      `${model.id} takes at most ${c.max_reference_images} reference images (got ${refImages.length})`,
    );
  }
  const hasMedia =
    input.image !== undefined ||
    input.endImage !== undefined ||
    input.video !== undefined ||
    input.audio !== undefined ||
    refImages.length + refVideos.length + refAudios.length > 0;
  const prompt = input.prompt?.trim() || undefined;
  if (!hasMedia) {
    needs(model, "text_to_video", "text-to-video (give an input such as --image or --video)");
    if (!prompt) throw new ValidationError("A prompt is required for text-to-video");
  }
  checkDuration(model, input.duration);
  oneOf(model, input.resolution, c.resolutions, "--resolution");
  oneOf(model, input.aspectRatio, c.aspect_ratios, "--aspect-ratio");

  const body: Record<string, unknown> = { model: model.id };
  setIf(body, "prompt", prompt);
  setIf(body, "image_url", input.image);
  setIf(body, "end_image_url", input.endImage);
  setIf(body, "reference_image_urls", refImages);
  setIf(body, "reference_video_urls", refVideos);
  setIf(body, "reference_audio_urls", refAudios);
  setIf(body, "video_url", input.video);
  setIf(body, "audio_url", input.audio);
  setIf(body, "duration", input.duration);
  setIf(body, "resolution", input.resolution);
  setIf(body, "aspect_ratio", input.aspectRatio);
  setIf(body, "generate_audio", input.generateAudio);
  checkRequestFields(model, body);
  return body;
}

/** Every media reference in a body, with where it sits. */
export function mediaRefs(body: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const field of MEDIA_FIELDS) {
    const value = body[field];
    if (typeof value === "string") refs.push(value);
    else if (Array.isArray(value))
      refs.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return refs;
}

/** A copy of `body` with each media reference passed through `map` (in order). */
export async function mapMediaRefs(
  body: Record<string, unknown>,
  map: (ref: string) => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...body };
  for (const field of MEDIA_FIELDS) {
    const value = body[field];
    if (typeof value === "string") {
      const mapped = await map(value);
      if (mapped === undefined) delete out[field];
      else out[field] = mapped;
    } else if (Array.isArray(value)) {
      const mapped: string[] = [];
      for (const v of value) {
        const m = typeof v === "string" ? await map(v) : undefined;
        if (m !== undefined) mapped.push(m);
      }
      if (mapped.length > 0) out[field] = mapped;
      else delete out[field];
    }
  }
  return out;
}
