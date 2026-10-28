/**
 * Sume's public model catalogue (`GET /v1/open/catalog`, no key) and the
 * pre-submit checks multix derives from it. Runtime-neutral: the caller
 * passes fetch; caching lives in the CLI layer.
 *
 * The catalogue has no JSON Schema per model. What it does state — `kind`,
 * `modes`, boolean `capabilities`, allowed value lists, and partial
 * `request_fields` hints (`required`, `omit`, `options`, `min`/`max`) — is
 * checked here before anything is billed. Everything else is left to the
 * server, whose router schemas reject unknown fields with a 400. An empty
 * list in the catalogue means "not stated", never "nothing allowed".
 */

import { ValidationError } from "../../core/errors.js";
import { SUME_CATALOG_URL } from "./models.js";

export interface SumeRequestField {
  required?: boolean;
  type?: string;
  description?: string;
  min?: number;
  max?: number;
  default?: unknown;
  omit?: boolean;
  options?: unknown[];
  media?: string;
}

export interface SumePriceOption {
  label?: string;
  usd?: string;
  resolution?: string;
  quality?: string;
}

export interface SumeCatalogModel {
  id: string;
  name?: string;
  description?: string;
  /** video | image | lipsync | captions (others are kept, never assumed). */
  kind: string;
  company?: string;
  modes: string[];
  pricing?: {
    currency?: string;
    unit?: string;
    from_usd?: string;
    to_usd?: string;
    qualifier?: string;
    options: SumePriceOption[];
  };
  capabilities: Record<string, unknown>;
  constraints: string[];
  request_fields?: Record<string, SumeRequestField>;
}

export interface SumeCatalog {
  currency: string;
  models: SumeCatalogModel[];
}

const TIMEOUT_MS = 15_000;

/** Catalogue text with control characters removed (it reaches terminals). */
function str(v: unknown): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "") : "";
  return s || undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => s !== undefined) : [];

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function parseField(v: unknown): SumeRequestField | undefined {
  const f = record(v);
  if (!f) return undefined;
  const out: SumeRequestField = {};
  if (typeof f.required === "boolean") out.required = f.required;
  if (typeof f.omit === "boolean") out.omit = f.omit;
  const type = str(f.type);
  if (type) out.type = type;
  const description = str(f.description);
  if (description) out.description = description;
  if (num(f.min) !== undefined) out.min = num(f.min);
  if (num(f.max) !== undefined) out.max = num(f.max);
  if (f.default !== undefined) out.default = f.default;
  if (Array.isArray(f.options)) {
    out.options = f.options.filter((o) => typeof o === "string" || typeof o === "number");
  }
  const media = str(f.media);
  if (media) out.media = media;
  return out;
}

function parseModel(v: unknown): SumeCatalogModel | undefined {
  const m = record(v);
  const id = str(m?.id);
  const kind = str(m?.kind);
  if (!m || !id || !kind) return undefined;
  const pricing = record(m.pricing);
  const fields = record(m.request_fields);
  const company = record(m.company);
  const model: SumeCatalogModel = {
    id,
    kind,
    modes: strings(m.modes),
    capabilities: record(m.capabilities) ?? {},
    constraints: strings(m.constraints),
  };
  const name = str(m.name);
  if (name) model.name = name;
  const description = str(m.description);
  if (description) model.description = description;
  const companyName = str(company?.name);
  if (companyName) model.company = companyName;
  if (pricing) {
    model.pricing = {
      options: (Array.isArray(pricing.options) ? pricing.options : []).flatMap((o) => {
        const opt = record(o);
        if (!opt) return [];
        const out: SumePriceOption = {};
        for (const key of ["label", "usd", "resolution", "quality"] as const) {
          const value = str(opt[key]);
          if (value) out[key] = value;
        }
        return [out];
      }),
    };
    for (const key of ["currency", "unit", "from_usd", "to_usd", "qualifier"] as const) {
      const value = str(pricing[key]);
      if (value) model.pricing[key] = value;
    }
  }
  if (fields) {
    model.request_fields = Object.fromEntries(
      Object.entries(fields).flatMap(([k, f]) => {
        const parsed = parseField(f);
        const key = str(k);
        return parsed && key ? [[key, parsed]] : [];
      }),
    );
  }
  return model;
}

/** Parse a catalogue response body. Throws on a body that is not catalogue-shaped. */
export function parseSumeCatalog(body: unknown): SumeCatalog {
  const data = record(record(body)?.data);
  if (!data || !Array.isArray(data.models)) {
    throw new Error("Sume catalogue response has no data.models list");
  }
  const models = data.models.map(parseModel).filter((m): m is SumeCatalogModel => !!m);
  return { currency: str(data.currency) ?? "USD", models };
}

/** Read the live catalogue. Throws on network, HTTP or shape errors. */
export async function readSumeCatalog(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ url: string; catalog: SumeCatalog }> {
  const res = await fetchFn(SUME_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} from ${new URL(SUME_CATALOG_URL).host}`);
  }
  return { url: SUME_CATALOG_URL, catalog: parseSumeCatalog(await res.json()) };
}

/** The non-router Sume Remix models name their own routes; `multix sume` does not call them. */
export function ownRoutes(model: SumeCatalogModel): string[] {
  return strings(model.capabilities.routes);
}

/** `from $0.1570 to $0.2350 per second`, or undefined without a price. */
export function formatPriceRange(model: SumeCatalogModel): string | undefined {
  const p = model.pricing;
  if (!p?.from_usd) return undefined;
  const unit = p.unit ? ` per ${p.unit}` : "";
  const range =
    p.to_usd && p.to_usd !== p.from_usd ? `$${p.from_usd}–$${p.to_usd}` : `$${p.from_usd}`;
  return `${range}${unit} (${p.currency ?? "USD"})`;
}

/** The flag that sets each request field, for error messages. */
const FLAG_FOR: Record<string, string> = {
  prompt: "<prompt>",
  image_urls: "--image",
  image_url: "--image",
  end_image_url: "--end-image",
  video_url: "--video",
  audio_url: "--audio",
  reference_image_urls: "--reference-image",
  duration: "--duration",
  resolution: "--resolution",
  aspect_ratio: "--aspect-ratio",
  generate_audio: "--generate-audio",
  image_size: "--image-size",
  quality: "--quality",
  num_images: "--num-images",
};

function label(field: string): string {
  const flag = FLAG_FOR[field];
  return flag ? `${flag} (${field})` : `${field} (set it with --input)`;
}

function getPath(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const part of path.split(".")) {
    const r = record(value);
    if (!r) return undefined;
    value = r[part];
  }
  return value;
}

const present = (v: unknown) =>
  v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

function oneOf(
  errors: string[],
  model: string,
  field: string,
  value: unknown,
  allowed: unknown,
): void {
  const list = Array.isArray(allowed) ? allowed : [];
  if (list.length === 0 || value === undefined || value === null) return;
  if (!list.includes(value)) {
    errors.push(
      `${label(field)} "${String(value)}" is not offered by ${model}; use one of: ${list.join(", ")}`,
    );
  }
}

function checkRequestFields(errors: string[], m: SumeCatalogModel, body: Record<string, unknown>) {
  for (const [field, spec] of Object.entries(m.request_fields ?? {})) {
    const value = getPath(body, field);
    const given = present(value);
    if (spec.omit && given) {
      errors.push(`${m.id} does not take ${label(field)}; leave it out`);
      continue;
    }
    if (spec.required && !given) {
      const hint = spec.description ? ` — ${spec.description}` : "";
      errors.push(`${m.id} requires ${label(field)}${hint}`);
      continue;
    }
    if (!given) continue;
    if (spec.options && spec.options.length > 0) oneOf(errors, m.id, field, value, spec.options);
    const size = Array.isArray(value)
      ? value.length
      : typeof value === "number"
        ? value
        : undefined;
    const what = Array.isArray(value) ? " items" : "";
    if (size !== undefined && spec.min !== undefined && size < spec.min) {
      errors.push(`${label(field)} must be at least ${spec.min}${what} for ${m.id}`);
    }
    if (size !== undefined && spec.max !== undefined && size > spec.max) {
      errors.push(`${label(field)} must be at most ${spec.max}${what} for ${m.id}`);
    }
  }
}

function checkImage(errors: string[], m: SumeCatalogModel, body: Record<string, unknown>) {
  const cap = m.capabilities;
  const images = present(body.image_urls);
  if (images && cap.image_edit === false) {
    errors.push(
      `${m.id} does not edit images (image_edit is false in the catalogue): drop --image`,
    );
  }
  if (!images && cap.text_to_image === false) {
    errors.push(`${m.id} only edits images (text_to_image is false): pass --image`);
  }
  oneOf(errors, m.id, "aspect_ratio", body.aspect_ratio, cap.aspect_ratios);
  oneOf(errors, m.id, "resolution", body.resolution, cap.resolutions);
  oneOf(errors, m.id, "quality", body.quality, cap.qualities);
  const max = num(cap.max_images);
  const n = num(body.num_images);
  if (max !== undefined && n !== undefined && n > max) {
    errors.push(`--num-images (num_images) must be at most ${max} for ${m.id}`);
  }
}

/** Fields that carry an input file for the video router. */
const VIDEO_MEDIA = [
  "image_url",
  "end_image_url",
  "video_url",
  "audio_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "image_urls",
];

function checkVideo(errors: string[], m: SumeCatalogModel, body: Record<string, unknown>) {
  const cap = m.capabilities;
  const has = (f: string) => present(body[f]);
  const refuse = (field: string, capability: string) =>
    errors.push(`${m.id} does not take ${label(field)} (${capability} is false in the catalogue)`);
  if (has("image_url") && cap.image_to_video === false) refuse("image_url", "image_to_video");
  if (has("end_image_url") && cap.end_frame === false) refuse("end_image_url", "end_frame");
  if (has("end_image_url") && !has("image_url")) {
    errors.push("--end-image (end_image_url) needs a first frame: pass --image too");
  }
  if (has("reference_image_urls") && cap.reference_images === false) {
    refuse("reference_image_urls", "reference_images");
  }
  const maxRefs = num(cap.max_reference_images);
  const refs = Array.isArray(body.reference_image_urls) ? body.reference_image_urls.length : 0;
  if (maxRefs !== undefined && refs > maxRefs) {
    errors.push(`${m.id} takes at most ${maxRefs} --reference-image`);
  }
  if (has("video_url") && cap.video_to_video === false) refuse("video_url", "video_to_video");
  if (has("audio_url") && cap.lipsync === false) refuse("audio_url", "lipsync");
  if (body.generate_audio === true && cap.audio === false) refuse("generate_audio", "audio");
  if (!VIDEO_MEDIA.some(has) && cap.text_to_video === false) {
    const modes = m.modes.length ? ` (modes: ${m.modes.join(", ")})` : "";
    errors.push(`${m.id} does not generate video from text alone${modes}: pass an input file`);
  }
  const duration = num(body.duration);
  if (duration !== undefined) {
    const values = Array.isArray(cap.duration_values) ? cap.duration_values : [];
    const range = record(cap.duration_seconds);
    const min = num(range?.min);
    const max = num(range?.max);
    if (values.length > 0) {
      if (!values.includes(duration)) {
        errors.push(`--duration must be one of ${values.join(", ")} seconds for ${m.id}`);
      }
    } else if ((min !== undefined && duration < min) || (max !== undefined && duration > max)) {
      errors.push(`--duration must be from ${min ?? "?"} to ${max ?? "?"} seconds for ${m.id}`);
    }
  }
  oneOf(errors, m.id, "resolution", body.resolution, cap.resolutions);
  oneOf(errors, m.id, "aspect_ratio", body.aspect_ratio, cap.aspect_ratios);
}

/** Kinds each router serves. */
const ROUTER_KINDS: Record<"image" | "video", readonly string[]> = {
  image: ["image"],
  video: ["video", "lipsync", "captions"],
};

/**
 * Throw a ValidationError when the catalogue says the request cannot work:
 * the model is not on that router, a field it marks `omit` is set, a required
 * one is missing, a capability it marks false is used, or a value falls
 * outside its stated list or range.
 */
export function validateAgainstCatalog(
  m: SumeCatalogModel,
  body: Record<string, unknown>,
  router: "image" | "video",
): void {
  const routes = ownRoutes(m);
  if (routes.length > 0) {
    throw new ValidationError(
      `${m.id} is not a router model (it runs on ${routes.join(", ")}), so multix sume ${router} cannot run it`,
    );
  }
  if (!ROUTER_KINDS[router].includes(m.kind)) {
    const other = m.kind === "image" ? "image" : "video";
    throw new ValidationError(
      `${m.id} is a ${m.kind} model; run it with multix sume ${other} instead`,
    );
  }
  const errors: string[] = [];
  checkRequestFields(errors, m, body);
  if (router === "image") checkImage(errors, m, body);
  else checkVideo(errors, m, body);
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw new ValidationError(unique[0] as string);
  if (unique.length > 1) {
    throw new ValidationError(`Request does not fit ${m.id}:\n  - ${unique.join("\n  - ")}`);
  }
}
