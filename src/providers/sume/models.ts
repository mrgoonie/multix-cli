/**
 * Sume API routing, links, id checks and catalog parsing.
 * Runtime-neutral: no node:* imports and no env access — callers resolve env
 * overrides (SUME_IMAGE_MODEL / SUME_VIDEO_MODEL) themselves.
 *
 * Sume has no built-in default model in multix: the public catalog
 * (GET /v1/open/catalog) is the list of what a key can buy, and every request
 * is checked against the chosen model's catalog row before it is sent.
 */

import { ValidationError } from "../../core/errors.js";
import type {
  SumeCapabilities,
  SumeCatalog,
  SumeKind,
  SumeModel,
  SumePriceOption,
  SumePricing,
  SumeRequestField,
} from "./types.js";

export const DEFAULT_SUME_BASE_URL = "https://api.sume.com";

/**
 * Base URL override and the key env name. Shared by the key lookup, the base
 * URL trust check and `multix check`, so the three cannot drift apart.
 */
export const SUME_ROUTING = {
  name: "SUME_BASE_URL",
  defaultUrl: DEFAULT_SUME_BASE_URL,
  keyEnvs: ["SUME_API_KEY"],
} as const;

/** Optional default models; without them (and without --model) the command refuses. */
export const SUME_IMAGE_MODEL_ENV = "SUME_IMAGE_MODEL";
export const SUME_VIDEO_MODEL_ENV = "SUME_VIDEO_MODEL";

/** Dashboard: API keys, balance, usage and billing (charges and refunds). */
export const SUME_DASHBOARD_LINK = "https://app.sume.com";
export const SUME_PRICING_LINK = "https://www.sume.com/pricing/api";
export const SUME_DOCS_LINK = "https://www.sume.com/docs";
export const SUME_CATALOG_PATH = "/v1/open/catalog";
/** The public catalog the price estimate is read from (its rate source). */
export const SUME_CATALOG_URL = `${DEFAULT_SUME_BASE_URL}${SUME_CATALOG_PATH}`;

/** Sume asks clients to poll no faster than this, whatever the hint says. */
export const MIN_POLL_INTERVAL_MS = 2_000;

export const SUME_KINDS: readonly SumeKind[] = ["image", "video", "lipsync", "captions"];

/** The router a catalog kind is submitted to. */
export function routerFor(kind: string): "image" | "video" {
  return kind === "image" ? "image" : "video";
}

/** Rows that list special routes (Sume remix tools) are not served by the routers. */
export function usesSpecialRoute(model: SumeModel): boolean {
  return (model.capabilities.routes ?? []).length > 0;
}

/** Job ids look like `job_<uuid>`; nothing else may reach a URL path, file name or printed command. */
const JOB_ID_RE = /^job_[A-Za-z0-9-]{8,128}$/;

export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

/** Reject anything but a Sume job id so it can never alter the request path. */
export function assertJobId(id: string): string {
  const trimmed = id.trim();
  if (!JOB_ID_RE.test(trimmed)) {
    throw new ValidationError(`Invalid Sume job id "${id}" — expected job_<id>`);
  }
  return trimmed;
}

/** Model ids may contain "/" (sumelabs/wand); anything else outside this set is refused. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function assertModelId(id: string): string {
  const trimmed = id.trim();
  if (!MODEL_ID_RE.test(trimmed) || trimmed.includes("..")) {
    throw new ValidationError(`Invalid Sume model id "${id}"`);
  }
  return trimmed;
}

/** Idempotency-Key: 1–255 printable ASCII characters (Sume's rule). */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7E]{1,255}$/;

export function assertIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY_RE.test(key) || !key.trim()) {
    throw new ValidationError("--idempotency-key must be 1-255 printable ASCII characters");
  }
  return key;
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const STATUS_ALIASES: Record<string, string> = {
  in_queue: "queued",
  in_progress: "processing",
  cancelled: "canceled",
};

/** `sume_status` (or `status`) in lower case; IN_QUEUE / IN_PROGRESS map to queued / processing. */
export function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const lower = clean(value).trim().toLowerCase().slice(0, 64);
  return STATUS_ALIASES[lower] ?? lower;
}

export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

// ---------------------------------------------------------------------------
// Catalog parsing: tolerant of extra fields, strict about types. Catalog text
// reaches terminals, so control characters are stripped.

/** Text with control characters removed (catalog and error text reach terminals). */
export function clean(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function str(value: unknown, max = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = clean(value).trim().slice(0, max);
  return s || undefined;
}

function strList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v, max))
    .filter((v): v is string => v !== undefined)
    .slice(0, 500);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const BOOL_CAPS = [
  "text_to_video",
  "image_to_video",
  "end_frame",
  "reference_images",
  "reference_videos",
  "reference_audios",
  "video_to_video",
  "audio",
  "lipsync",
  "captions",
  "dubbing",
  "text_to_image",
  "image_edit",
] as const;
const LIST_CAPS = [
  "resolutions",
  "aspect_ratios",
  "qualities",
  "output_formats",
  "routes",
] as const;

function parseCapabilities(value: unknown): SumeCapabilities {
  const raw = record(value) ?? {};
  const caps: SumeCapabilities = {};
  for (const key of BOOL_CAPS) {
    const b = bool(raw[key]);
    if (b !== undefined) caps[key] = b;
  }
  for (const key of LIST_CAPS) {
    if (Array.isArray(raw[key])) caps[key] = strList(raw[key]);
  }
  const tool = str(raw.video_tool, 100);
  if (tool) caps.video_tool = tool;
  const duration = record(raw.duration_seconds);
  const min = finite(duration?.min);
  const max = finite(duration?.max);
  if (min !== undefined && max !== undefined && min >= 0 && max >= min) {
    caps.duration_seconds = { min, max };
  }
  if (Array.isArray(raw.duration_values)) {
    const values = raw.duration_values.filter(
      (v): v is number => finite(v) !== undefined && (v as number) > 0,
    );
    if (values.length > 0) caps.duration_values = values;
  }
  const maxRefs = finite(raw.max_reference_images);
  if (maxRefs !== undefined && maxRefs >= 0) caps.max_reference_images = maxRefs;
  const maxImages = finite(raw.max_images);
  if (maxImages !== undefined && maxImages >= 1) caps.max_images = maxImages;
  return caps;
}

function parseRequestFields(value: unknown): Record<string, SumeRequestField> | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const out: Record<string, SumeRequestField> = {};
  for (const [name, spec] of Object.entries(raw)) {
    const key = str(name, 100);
    const field = record(spec);
    if (!key || !field || !/^[A-Za-z0-9_.]+$/.test(key)) continue;
    const parsed: SumeRequestField = {};
    const required = bool(field.required);
    if (required !== undefined) parsed.required = required;
    const omit = bool(field.omit);
    if (omit !== undefined) parsed.omit = omit;
    const type = str(field.type, 40);
    if (type) parsed.type = type;
    const description = str(field.description, 500);
    if (description) parsed.description = description;
    const min = finite(field.min);
    if (min !== undefined) parsed.min = min;
    const max = finite(field.max);
    if (max !== undefined) parsed.max = max;
    const media = str(field.media, 40);
    if (media) parsed.media = media;
    if (Array.isArray(field.options)) parsed.options = strList(field.options);
    const d = field.default;
    if (d === null) parsed.default = null;
    else if (typeof d === "string") parsed.default = clean(d).slice(0, 200);
    else if (typeof d === "boolean" || finite(d) !== undefined) parsed.default = d as number;
    out[key] = parsed;
  }
  return out;
}

/** USD micros from `usd_micros`, else from the decimal `usd` string. */
function micros(option: Record<string, unknown>): number | undefined {
  const m = finite(option.usd_micros);
  if (m !== undefined && m >= 0 && Number.isInteger(m)) return m;
  const usd = typeof option.usd === "string" ? option.usd.trim() : "";
  if (!/^\d+(\.\d{1,6})?$/.test(usd)) return undefined;
  const [whole = "0", frac = ""] = usd.split(".");
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
}

function parsePricing(value: unknown): SumePricing | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const unit = str(raw.unit, 40);
  if (!unit) return undefined;
  const options: SumePriceOption[] = [];
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    const option = record(item);
    if (!option) continue;
    const usdMicros = micros(option);
    if (usdMicros === undefined) continue;
    const parsed: SumePriceOption = {
      label: str(option.label, 200) ?? "",
      usd: (usdMicros / 1_000_000).toString(),
      usd_micros: usdMicros,
    };
    const resolution = str(option.resolution, 40);
    if (resolution) parsed.resolution = resolution;
    const quality = str(option.quality, 40);
    if (quality) parsed.quality = quality;
    const audio = bool(option.audio);
    if (audio !== undefined) parsed.audio = audio;
    options.push(parsed);
  }
  const pricing: SumePricing = { currency: str(raw.currency, 10) ?? "USD", unit, options };
  const from = str(raw.from_usd, 40);
  if (from) pricing.from_usd = from;
  const to = str(raw.to_usd, 40);
  if (to) pricing.to_usd = to;
  return pricing;
}

/** One catalog row, or undefined when it has no usable id or kind. */
export function parseCatalogModel(value: unknown): SumeModel | undefined {
  const raw = record(value);
  const id = str(raw?.id, 128);
  const kind = str(raw?.kind, 40);
  if (!raw || !id || !kind || !MODEL_ID_RE.test(id)) return undefined;
  const model: SumeModel = {
    id,
    kind,
    modes: strList(raw.modes, 80),
    capabilities: parseCapabilities(raw.capabilities),
    constraints: strList(raw.constraints, 1_000),
  };
  const slug = str(raw.slug, 200);
  if (slug) model.slug = slug;
  const name = str(raw.name, 200);
  if (name) model.name = name;
  const company = str(record(raw.company)?.name, 200) ?? str(raw.company, 200);
  if (company) model.company = company;
  const description = str(raw.description, 1_000);
  if (description) model.description = description;
  const fields = parseRequestFields(raw.request_fields);
  if (fields) model.request_fields = fields;
  const pricing = parsePricing(raw.pricing);
  if (pricing) model.pricing = pricing;
  return model;
}

/** `GET /v1/open/catalog` body (`{data:{currency, models}}`) → parsed rows. Throws when it has no list. */
export function parseCatalog(body: unknown): SumeCatalog {
  const data = record(record(body)?.data);
  if (!data || !Array.isArray(data.models)) {
    throw new Error("Sume catalog response has no models list");
  }
  const models: SumeModel[] = [];
  const seen = new Set<string>();
  for (const row of data.models) {
    const model = parseCatalogModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { currency: str(data.currency, 10) ?? "USD", models };
}

/** `$0.1028` style price text for a micros amount. */
export function formatUsdMicros(value: number): string {
  const usd = value / 1_000_000;
  return `$${usd >= 0.01 ? usd.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1") : usd.toPrecision(3)}`;
}

/** "from $0.10 to $0.57 per second" for a model row (or "price not listed"). */
export function priceSummary(model: SumeModel): string {
  const pricing = model.pricing;
  if (!pricing || pricing.options.length === 0) return "price not listed";
  const values = pricing.options.map((o) => o.usd_micros);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range =
    low === high ? formatUsdMicros(low) : `${formatUsdMicros(low)}-${formatUsdMicros(high)}`;
  return `${range} per ${pricing.unit}`;
}

/** Short capability list for `sume models`. */
export function capabilitySummary(model: SumeModel): string {
  const c = model.capabilities;
  const parts: string[] = [];
  const flags: Array<[keyof SumeCapabilities, string]> = [
    ["text_to_image", "text"],
    ["image_edit", "edit"],
    ["text_to_video", "text"],
    ["image_to_video", "first-frame"],
    ["end_frame", "end-frame"],
    ["reference_images", "reference-images"],
    ["video_to_video", "video-input"],
    ["lipsync", "lipsync"],
    ["captions", "captions"],
    ["audio", "audio"],
  ];
  for (const [key, label] of flags) if (c[key] === true) parts.push(label);
  if (c.duration_values) parts.push(`${c.duration_values.join("/")}s`);
  else if (c.duration_seconds) parts.push(`${c.duration_seconds.min}-${c.duration_seconds.max}s`);
  if (c.resolutions?.length) parts.push(c.resolutions.join("/"));
  if (c.max_images) parts.push(`up to ${c.max_images} images`);
  return parts.join(", ");
}
