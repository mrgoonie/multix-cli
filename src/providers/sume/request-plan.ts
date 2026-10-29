/**
 * Check generation flags against a model's catalog row and build the request
 * body, before anything is uploaded, sent or billed. Runtime-neutral: shared
 * by the commands, the pre-flight price estimate and `sume estimate`.
 *
 * What a model takes comes from its row only: `kind`, `capabilities` and
 * (when present) `request_fields`. A flag the row does not confirm is
 * refused rather than sent on the chance that the model takes it.
 * Media flags are recorded as raw values (path or URL); the command layer
 * uploads local files and fills them in.
 */

import { ValidationError } from "../../core/errors.js";
import { routerFor, usesSpecialRoute } from "./models.js";
import type { SumeModel, SumeRequestField } from "./types.js";

export type SumeCommandKind = "image" | "video";

/** Generation flags, as parsed from commander (camelCase) or MCP (kebab-case) options. */
export interface SumeFlags {
  /** image: `image_urls` (repeatable); video: `image_url` (first frame, one value). */
  image?: string[];
  endImage?: string;
  referenceImage?: string[];
  video?: string;
  audio?: string;
  aspectRatio?: string;
  imageSize?: string;
  quality?: string;
  resolution?: string;
  numImages?: string;
  outputFormat?: string;
  duration?: string;
  generateAudio?: boolean;
  /** `key=value` pairs for request_fields without a dedicated flag. */
  param?: string[];
}

export type SumeMediaKind = "image" | "video" | "audio";

export interface SumeMediaInput {
  /** Request field the URLs go into. */
  field: string;
  /** The flag the values came from, for messages. */
  flag: string;
  values: string[];
  list: boolean;
  media: SumeMediaKind;
}

export interface SumePlan {
  router: "image" | "video";
  model: SumeModel;
  /** Body without media fields (they need uploading first). */
  body: Record<string, unknown> & { model: string };
  media: SumeMediaInput[];
}

/** Sume's own limits for image_urls (1–16) and num_images (1–4) when the row says nothing narrower. */
const IMAGE_URLS_MAX = 16;
const PROMPT_MAX_CHARS = 20_000;

/** request_fields keys a dedicated flag (or the prompt argument) fills. */
const FLAG_FOR_FIELD: Record<string, string> = {
  prompt: "the prompt argument",
  image_urls: "--image",
  image_url: "--image",
  end_image_url: "--end-image",
  reference_image_urls: "--reference-image",
  video_url: "--video",
  audio_url: "--audio",
  aspect_ratio: "--aspect-ratio",
  image_size: "--image-size",
  quality: "--quality",
  resolution: "--resolution",
  num_images: "--num-images",
  output_format: "--output-format",
  duration: "--duration",
  generate_audio: "--generate-audio",
};

/** Request fields multix sets itself; never through --param. */
const RESERVED_FIELDS = new Set([
  "model",
  "mode",
  "webhook_url",
  "wait_timeout_seconds",
  "metadata",
]);

function fail(message: string): never {
  throw new ValidationError(message);
}

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function pickOption(options: Record<string, unknown>, name: string): unknown {
  return options[name] ?? options[camel(name)] ?? options[`--${name}`];
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((v) =>
    typeof v === "number" ? String(v) : v,
  );
  const out = list.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function one(value: unknown): string | undefined {
  return strings(value)?.[0];
}

/** Read the generation flags from an option record (commander or MCP spelling). */
export function flagsFromOptions(options: Record<string, unknown>): SumeFlags {
  const flags: SumeFlags = {};
  const listFlags = ["image", "reference-image", "param"] as const;
  for (const name of listFlags) {
    const values = strings(pickOption(options, name));
    if (values) flags[camel(name) as "image" | "referenceImage" | "param"] = values;
  }
  const single = [
    "end-image",
    "video",
    "audio",
    "aspect-ratio",
    "image-size",
    "quality",
    "resolution",
    "num-images",
    "output-format",
    "duration",
  ] as const;
  for (const name of single) {
    const value = one(pickOption(options, name));
    if (value !== undefined) (flags as Record<string, unknown>)[camel(name)] = value;
  }
  const audio = pickOption(options, "generate-audio");
  if (typeof audio === "boolean") flags.generateAudio = audio;
  else if (audio === "true" || audio === "false") flags.generateAudio = audio === "true";
  return flags;
}

function fieldOf(model: SumeModel, name: string): SumeRequestField | undefined {
  return model.request_fields?.[name];
}

/** Refuse a flag whose field the row marks `omit`. */
function assertNotOmitted(model: SumeModel, field: string, flag: string): void {
  if (fieldOf(model, field)?.omit) fail(`${model.id} does not take ${flag}`);
}

function listOrNone(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none listed";
}

/** A value from a catalog list (or the field's options); refused when the row lists none. */
function checkChoice(
  model: SumeModel,
  field: string,
  flag: string,
  value: string,
  listed: readonly string[] | undefined,
): string {
  assertNotOmitted(model, field, flag);
  const options = fieldOf(model, field)?.options ?? listed ?? [];
  if (options.length === 0) {
    fail(`${model.id} does not list any ${flag.replace(/^--/, "")} values, so ${flag} is not sent`);
  }
  if (!options.includes(value)) {
    fail(`${flag} ${value} is not supported by ${model.id}. Use one of: ${options.join(", ")}`);
  }
  return value;
}

function parseWhole(raw: string, flag: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) fail(`${flag} must be a whole number`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) fail(`${flag} is too large`);
  return n;
}

/** min/max of a request field, refused outside them. */
function checkRange(model: SumeModel, field: string, flag: string, n: number): void {
  const spec = fieldOf(model, field);
  if (spec?.min !== undefined && n < spec.min)
    fail(`${flag} must be at least ${spec.min} for ${model.id}`);
  if (spec?.max !== undefined && n > spec.max)
    fail(`${flag} must be at most ${spec.max} for ${model.id}`);
}

function checkCount(
  model: SumeModel,
  field: string,
  flag: string,
  count: number,
  max?: number,
): void {
  const spec = fieldOf(model, field);
  const hi = Math.min(spec?.max ?? Number.POSITIVE_INFINITY, max ?? Number.POSITIVE_INFINITY);
  if (spec?.min !== undefined && count < spec.min) {
    fail(`${model.id} needs at least ${spec.min} ${flag} value(s)`);
  }
  if (count > hi) fail(`${model.id} accepts at most ${hi} ${flag} value(s)`);
}

function nonEmpty(values: string[] | undefined, flag: string): string[] {
  const list = values ?? [];
  for (const v of list) if (!v.trim()) fail(`${flag} must not be empty`);
  return list.map((v) => v.trim());
}

/** Set `a.b` = value as a nested object (captions.style → {captions:{style}}). */
function setPath(body: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let target = body;
  for (const part of parts.slice(0, -1)) {
    const next = target[part];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      target = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      target[part] = created;
      target = created;
    }
  }
  target[parts[parts.length - 1] as string] = value;
}

function hasPath(body: Record<string, unknown>, key: string): boolean {
  let target: unknown = body;
  for (const part of key.split(".")) {
    if (!target || typeof target !== "object") return false;
    target = (target as Record<string, unknown>)[part];
  }
  return target !== undefined;
}

/** `--param key=value`: only request_fields the row lists (and no dedicated flag covers). */
function applyParams(model: SumeModel, params: string[], body: Record<string, unknown>): void {
  const seen = new Set<string>();
  for (const raw of params) {
    const eq = raw.indexOf("=");
    if (eq <= 0) fail(`--param must be key=value (got "${raw}")`);
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (RESERVED_FIELDS.has(key)) fail(`--param ${key} is set by multix and cannot be overridden`);
    const flag = FLAG_FOR_FIELD[key];
    if (flag) fail(`--param ${key}: use ${flag} instead`);
    const spec = fieldOf(model, key);
    if (!spec) {
      const listed = Object.entries(model.request_fields ?? {})
        .filter(([k, f]) => !f.omit && !FLAG_FOR_FIELD[k])
        .map(([k]) => k);
      fail(
        `--param ${key} is not a request field of ${model.id}. Fields it lists for --param: ${listOrNone(listed)}`,
      );
    }
    if (spec.omit) fail(`${model.id} does not take ${key}`);
    if (seen.has(key)) fail(`--param ${key} is given twice`);
    seen.add(key);
    let parsed: unknown = value;
    if (spec.type === "integer") {
      parsed = parseWhole(value, `--param ${key}`);
      checkRange(model, key, `--param ${key}`, parsed as number);
    } else if (spec.type === "boolean") {
      if (value !== "true" && value !== "false") fail(`--param ${key} must be true or false`);
      parsed = value === "true";
    } else if (spec.type === "string[]") {
      parsed = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      checkCount(model, key, `--param ${key}`, (parsed as string[]).length);
    } else if (!value.trim()) {
      fail(`--param ${key} must not be empty`);
    }
    if (spec.options && spec.options.length > 0 && !spec.options.includes(value)) {
      fail(
        `--param ${key}=${value} is not supported by ${model.id}. Use one of: ${spec.options.join(", ")}`,
      );
    }
    setPath(body, key, parsed);
  }
}

/**
 * Required request fields: filled from their schema default when the row
 * gives one, otherwise refused with the flag that supplies them.
 */
function applyRequired(
  model: SumeModel,
  body: Record<string, unknown>,
  media: SumeMediaInput[],
  hasPrompt: boolean,
  checkPrompt: boolean,
): void {
  for (const [key, spec] of Object.entries(model.request_fields ?? {})) {
    if (!spec.required || spec.omit) continue;
    if (key === "prompt") {
      if (checkPrompt && !hasPrompt) fail(`${model.id} needs a prompt`);
      continue;
    }
    if (hasPath(body, key) || media.some((m) => m.field === key)) continue;
    if (spec.default !== undefined && spec.default !== null) {
      setPath(body, key, spec.default);
      continue;
    }
    const flag = FLAG_FOR_FIELD[key] ?? `--param ${key}=<value>`;
    fail(`${model.id} needs ${flag}${spec.description ? ` (${spec.description})` : ""}`);
  }
}

function planImage(
  model: SumeModel,
  flags: SumeFlags,
  body: Record<string, unknown>,
): SumeMediaInput[] {
  const c = model.capabilities;
  const media: SumeMediaInput[] = [];
  const images = nonEmpty(flags.image, "--image");
  if (images.length > 0) {
    assertNotOmitted(model, "image_urls", "--image");
    if (c.image_edit !== true && !fieldOf(model, "image_urls")) {
      fail(`${model.id} does not take input images (--image)`);
    }
    checkCount(model, "image_urls", "--image", images.length, IMAGE_URLS_MAX);
    media.push({
      field: "image_urls",
      flag: "--image",
      values: images,
      list: true,
      media: "image",
    });
  } else if (c.text_to_image === false) {
    fail(`${model.id} edits images only: pass --image <path|url>`);
  }
  for (const [flag, name] of [
    ["--end-image", "endImage"],
    ["--reference-image", "referenceImage"],
    ["--video", "video"],
    ["--audio", "audio"],
    ["--duration", "duration"],
    ["--generate-audio", "generateAudio"],
  ] as const) {
    if (flags[name] !== undefined) fail(`${flag} is a video flag; sume image does not take it`);
  }
  if (flags.aspectRatio !== undefined) {
    body.aspect_ratio = checkChoice(
      model,
      "aspect_ratio",
      "--aspect-ratio",
      flags.aspectRatio,
      c.aspect_ratios,
    );
  }
  if (flags.imageSize !== undefined) {
    assertNotOmitted(model, "image_size", "--image-size");
    // image_size is the router's alternative to aspect_ratio; only models that let the shape be chosen take it.
    if (!(c.aspect_ratios ?? []).length && !fieldOf(model, "image_size")) {
      fail(`${model.id} does not let the output size be chosen, so --image-size is not sent`);
    }
    const size = flags.imageSize.trim();
    if (!/^(\d{2,5}x\d{2,5}|[a-z][a-z0-9_]{1,40})$/.test(size)) {
      fail("--image-size must be WIDTHxHEIGHT (e.g. 1024x768) or a preset name");
    }
    body.image_size = size;
  }
  if (flags.quality !== undefined) {
    body.quality = checkChoice(model, "quality", "--quality", flags.quality, c.qualities);
  }
  if (flags.resolution !== undefined) {
    body.resolution = checkChoice(
      model,
      "resolution",
      "--resolution",
      flags.resolution,
      c.resolutions,
    );
  }
  if (flags.outputFormat !== undefined) {
    body.output_format = checkChoice(
      model,
      "output_format",
      "--output-format",
      flags.outputFormat,
      c.output_formats,
    );
  }
  if (flags.numImages !== undefined) {
    assertNotOmitted(model, "num_images", "--num-images");
    const n = parseWhole(flags.numImages, "--num-images");
    const spec = fieldOf(model, "num_images");
    const max = spec?.max ?? c.max_images ?? 1;
    const min = spec?.min ?? 1;
    if (n < min || n > max) fail(`--num-images must be from ${min} to ${max} for ${model.id}`);
    body.num_images = n;
  }
  return media;
}

function planVideo(
  model: SumeModel,
  flags: SumeFlags,
  body: Record<string, unknown>,
): SumeMediaInput[] {
  const c = model.capabilities;
  const media: SumeMediaInput[] = [];
  const lipsync = c.lipsync === true || model.kind === "lipsync";
  const [image, ...extra] = nonEmpty(flags.image, "--image");
  if (extra.length > 0)
    fail("sume video takes one --image (the first frame); use --reference-image for more");
  if (image !== undefined) {
    assertNotOmitted(model, "image_url", "--image");
    if (c.image_to_video !== true && !(lipsync && model.modes.includes("image-to-lipsync"))) {
      fail(`${model.id} does not take a first-frame image (--image)`);
    }
    media.push({
      field: "image_url",
      flag: "--image",
      values: [image],
      list: false,
      media: "image",
    });
  }
  if (flags.endImage !== undefined) {
    const end = nonEmpty([flags.endImage], "--end-image");
    assertNotOmitted(model, "end_image_url", "--end-image");
    if (c.end_frame !== true) fail(`${model.id} does not take an end frame (--end-image)`);
    if (image === undefined) fail("--end-image needs --image (the first frame)");
    media.push({
      field: "end_image_url",
      flag: "--end-image",
      values: end,
      list: false,
      media: "image",
    });
  }
  const refs = nonEmpty(flags.referenceImage, "--reference-image");
  if (refs.length > 0) {
    assertNotOmitted(model, "reference_image_urls", "--reference-image");
    if (c.reference_images !== true && !fieldOf(model, "reference_image_urls")) {
      fail(`${model.id} does not take reference images (--reference-image)`);
    }
    const max =
      c.max_reference_images && c.max_reference_images > 0 ? c.max_reference_images : undefined;
    checkCount(model, "reference_image_urls", "--reference-image", refs.length, max);
    media.push({
      field: "reference_image_urls",
      flag: "--reference-image",
      values: refs,
      list: true,
      media: "image",
    });
  }
  if (flags.video !== undefined) {
    const video = nonEmpty([flags.video], "--video");
    assertNotOmitted(model, "video_url", "--video");
    if (c.video_to_video !== true && !fieldOf(model, "video_url")) {
      fail(`${model.id} does not take a source video (--video)`);
    }
    media.push({ field: "video_url", flag: "--video", values: video, list: false, media: "video" });
  }
  if (flags.audio !== undefined) {
    const audio = nonEmpty([flags.audio], "--audio");
    assertNotOmitted(model, "audio_url", "--audio");
    if (!lipsync) fail(`${model.id} does not take an audio track (--audio is for lip-sync models)`);
    media.push({ field: "audio_url", flag: "--audio", values: audio, list: false, media: "audio" });
  } else if (lipsync) {
    fail(`${model.id} is a lip-sync model: pass the speech with --audio <path|url>`);
  }
  if (lipsync && image === undefined && flags.video === undefined) {
    const face = model.modes.includes("video-to-lipsync") ? "--video" : "--image";
    fail(`${model.id} is a lip-sync model: pass the face with ${face} <path|url>`);
  }
  if (media.length === 0 && c.text_to_video !== true) {
    const modes = model.modes.length > 0 ? ` (modes: ${model.modes.join(", ")})` : "";
    fail(
      `${model.id} does not make video from text alone${modes}: pass its input with --image, --video, --audio or --reference-image`,
    );
  }
  for (const [flag, name] of [
    ["--image-size", "imageSize"],
    ["--quality", "quality"],
    ["--num-images", "numImages"],
    ["--output-format", "outputFormat"],
  ] as const) {
    if (flags[name] !== undefined) fail(`${flag} is an image flag; sume video does not take it`);
  }
  if (flags.duration !== undefined) {
    assertNotOmitted(model, "duration", "--duration");
    const n = parseWhole(flags.duration, "--duration");
    const spec = fieldOf(model, "duration");
    const range = c.duration_seconds;
    if (!spec && !range && !c.duration_values) {
      fail(`${model.id} does not list a duration, so --duration is not sent`);
    }
    if (c.duration_values && !c.duration_values.includes(n)) {
      fail(`--duration must be one of ${c.duration_values.join(", ")} seconds for ${model.id}`);
    }
    const min = spec?.min ?? range?.min;
    const max = spec?.max ?? range?.max;
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
      fail(`--duration must be from ${min ?? 1} to ${max ?? "any"} seconds for ${model.id}`);
    }
    body.duration = n;
  }
  if (flags.resolution !== undefined) {
    body.resolution = checkChoice(
      model,
      "resolution",
      "--resolution",
      flags.resolution,
      c.resolutions,
    );
  }
  if (flags.aspectRatio !== undefined) {
    body.aspect_ratio = checkChoice(
      model,
      "aspect_ratio",
      "--aspect-ratio",
      flags.aspectRatio,
      c.aspect_ratios,
    );
  }
  if (flags.generateAudio !== undefined) {
    const flag = flags.generateAudio ? "--generate-audio" : "--no-generate-audio";
    assertNotOmitted(model, "generate_audio", flag);
    // On lip-sync rows `audio` means the speech input; they make no soundtrack of their own.
    if (c.audio !== true || lipsync) {
      fail(`${model.id} does not make a soundtrack, so ${flag} is not sent`);
    }
    body.generate_audio = flags.generateAudio;
  }
  return media;
}

export interface PlanInput {
  command: SumeCommandKind;
  model: SumeModel;
  prompt?: string;
  flags: SumeFlags;
  /**
   * Check the prompt (needed, refused). The pre-flight price estimate has no
   * prompt to check; the command itself always checks it.
   */
  checkPrompt?: boolean;
}

/** Validate every flag against the model's catalog row; throws ValidationError. */
export function planSumeRequest(input: PlanInput): SumePlan {
  const { command, model, flags } = input;
  const checkPrompt = input.checkPrompt ?? true;
  if (usesSpecialRoute(model)) {
    fail(
      `${model.id} runs on a special Sume route (${(model.capabilities.routes ?? []).join(", ")}) that is not supported by multix yet`,
    );
  }
  const router = routerFor(model.kind);
  if (router !== command) {
    fail(
      command === "image"
        ? `${model.id} is a ${model.kind} model; use sume video`
        : `${model.id} is an image model; use sume image`,
    );
  }
  if (!["image", "video", "lipsync", "captions"].includes(model.kind)) {
    fail(`${model.id} has kind "${model.kind}", which multix does not know how to send`);
  }
  const body: Record<string, unknown> & { model: string } = { model: model.id };
  const prompt = input.prompt;
  const hasPrompt = prompt !== undefined && prompt.trim() !== "";
  if (checkPrompt) {
    if (prompt !== undefined && !hasPrompt) fail("Prompt must not be empty");
    if (hasPrompt) {
      if (fieldOf(model, "prompt")?.omit) fail(`${model.id} does not take a prompt`);
      if ((prompt as string).length > PROMPT_MAX_CHARS) {
        fail(
          `Prompt is ${(prompt as string).length} characters; multix sends at most ${PROMPT_MAX_CHARS}`,
        );
      }
      body.prompt = prompt;
    } else if (command === "image") {
      fail("sume image needs a prompt");
    }
  }
  const media = command === "image" ? planImage(model, flags, body) : planVideo(model, flags, body);
  applyParams(model, flags.param ?? [], body);
  applyRequired(model, body, media, hasPrompt, checkPrompt);
  return { router, model, body, media };
}

/** The request body with uploaded media URLs filled in. */
export function withMedia(
  plan: SumePlan,
  urls: Map<SumeMediaInput, string[]>,
): Record<string, unknown> & { model: string } {
  const body = { ...plan.body };
  for (const item of plan.media) {
    const values = urls.get(item) ?? item.values;
    body[item.field] = item.list ? values : values[0];
  }
  return body;
}
