/**
 * Schema-driven request building for Atlas Cloud models.
 * Runtime-neutral (no node:* imports).
 *
 * Every Atlas model publishes its own OpenAPI document; field names and value
 * formats differ per model (`image` vs `images[]`, `1024*1024` vs `1024x1024`,
 * `text` vs `prompt`). Convenience flags are mapped onto whichever candidate
 * field the selected model actually declares, and unsupported combinations
 * fail before any billable submit. The Atlas API itself accepts incomplete
 * payloads and silently fills defaults, so this check is the only guard.
 */

import { ValidationError } from "../../core/errors.js";
import type { AtlasMediaKind, AtlasModelSpec, AtlasSchemaProperty } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI documents are untyped JSON
type Json = any;

const SUBMIT_PATH_RE = /\/model\/generate(Image|Video|Audio)$/;

function resolveRef(doc: Json, ref: unknown): Json {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node: Json = doc;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Extract the submit endpoint and input schema from a model's OpenAPI document.
 * The submit path is authoritative: some catalog "Image" models are served by
 * generateVideo and vice versa. Returns undefined when the document has no
 * usable input schema.
 */
export function parseModelSpec(model: string, doc: unknown): AtlasModelSpec | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as Json;
  let endpoint: AtlasMediaKind | undefined;
  let input: Json;
  for (const [p, ops] of Object.entries<Json>(d.paths ?? {})) {
    const m = SUBMIT_PATH_RE.exec(p);
    if (!m?.[1] || !ops?.post) continue;
    endpoint = m[1].toLowerCase() as AtlasMediaKind;
    const schema = ops.post.requestBody?.content?.["application/json"]?.schema;
    input = schema?.$ref ? resolveRef(d, schema.$ref) : schema;
    break;
  }
  input ??= d.components?.schemas?.Input;
  if (!input || typeof input.properties !== "object") return undefined;
  return {
    model,
    endpoint,
    properties: input.properties as Record<string, AtlasSchemaProperty>,
    required: Array.isArray(input.required)
      ? input.required.filter((r: unknown) => typeof r === "string")
      : [],
  };
}

/**
 * Schema field names each convenience flag may map onto, in preference order.
 * Derived from the field names actually used across the Atlas catalog schemas
 * (e.g. 129 models take `image: string`, 61 take `images: string[]`).
 */
export const FIELD_CANDIDATES = {
  prompt: ["prompt"],
  negativePrompt: ["negative_prompt"],
  seed: ["seed"],
  size: ["size", "image_size"],
  aspectRatio: ["aspect_ratio"],
  resolution: ["resolution"],
  duration: ["duration"],
  numImages: ["num_images"],
  editImages: [
    "images",
    "image",
    "image_urls",
    "reference_images",
    "image_url",
    "reference_image_urls",
  ],
  primaryImage: [
    "image",
    "image_url",
    "images",
    "image_urls",
    "reference_images",
    "reference_image_urls",
  ],
  speechText: ["text", "prompt"],
  audioInput: ["audio_url", "audio"],
  voice: ["voice_id", "voice"],
  audioFormat: ["format", "codec", "output_format"],
  language: ["language"],
  modelFormat: ["format", "output_format", "target_formats"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Types assumed for each first-choice candidate when no schema is available,
 * matching how the catalog declares them. Anything unlisted is a string, so a
 * single `--ref` becomes `image: "<url>"` rather than a one-element array.
 */
const FALLBACK_FIELD_TYPES: Record<string, string> = {
  seed: "integer",
  num_images: "integer",
  duration: "number",
  images: "array",
};

/** One convenience flag and the schema fields it may map onto, in preference order. */
export interface FieldRequest {
  /** CLI flag shown in errors, e.g. "--duration". */
  flag: string;
  value: string | number | boolean | string[] | undefined;
  candidates: readonly string[];
}

function coerce(
  flag: string,
  field: string,
  prop: AtlasSchemaProperty,
  value: Exclude<FieldRequest["value"], undefined>,
): unknown {
  const type = prop.type;
  if (Array.isArray(value)) {
    if (type === "array") return value;
    if (value.length === 1) return coerceScalar(flag, field, type, value[0] as string);
    throw new ValidationError(
      `${flag}: field "${field}" of this model accepts a single value, got ${value.length}`,
    );
  }
  if (type === "array") return [coerceScalar(flag, field, prop.items?.type, value)];
  return coerceScalar(flag, field, type, value);
}

function coerceScalar(
  flag: string,
  field: string,
  type: string | undefined,
  value: string | number | boolean,
): unknown {
  if (type === "integer" || type === "number") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) {
      throw new ValidationError(`${flag}: "${value}" is not a valid ${type} for "${field}"`);
    }
    return n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
    throw new ValidationError(`${flag}: "${value}" is not a boolean for "${field}"`);
  }
  if (type === "string") return String(value);
  return value;
}

function checkConstraints(
  flag: string,
  field: string,
  prop: AtlasSchemaProperty,
  v: unknown,
): void {
  const values = Array.isArray(v) ? v : [v];
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && !Array.isArray(v)) {
    if (!prop.enum.some((e) => e === v || String(e) === String(v))) {
      throw new ValidationError(
        `${flag}: "${String(v)}" is not supported by this model. Valid ${field}: ${prop.enum.map(String).join(", ")}`,
      );
    }
  }
  for (const item of values) {
    if (typeof item !== "number") continue;
    if (prop.minimum !== undefined && item < prop.minimum) {
      throw new ValidationError(
        `${flag}: ${item} is below the minimum ${prop.minimum} for "${field}"`,
      );
    }
    if (prop.maximum !== undefined && item > prop.maximum) {
      throw new ValidationError(
        `${flag}: ${item} exceeds the maximum ${prop.maximum} for "${field}"`,
      );
    }
  }
  if (Array.isArray(v) && prop.maxItems !== undefined && v.length > prop.maxItems) {
    throw new ValidationError(
      `${flag}: this model accepts at most ${prop.maxItems} item(s) for "${field}", got ${v.length}`,
    );
  }
}

/** Pick the candidate field: the first declared one, preferring arrays for multi-value input. */
function pickField(spec: AtlasModelSpec, req: FieldRequest): string | undefined {
  const declared = req.candidates.filter((c) => spec.properties[c] !== undefined);
  // URL/text input must not land on a same-named boolean (e.g. `audio: boolean` on video models).
  const compatible = declared.filter((c) => {
    if (spec.properties[c]?.type !== "boolean") return true;
    const v = req.value;
    return typeof v === "boolean" || (typeof v === "string" && /^(true|false)$/i.test(v));
  });
  if (Array.isArray(req.value) && req.value.length > 1) {
    return compatible.find((c) => spec.properties[c]?.type === "array") ?? compatible[0];
  }
  return compatible[0];
}

/**
 * Build a request body (without `model`) from convenience flags.
 * With a spec: map each flag onto a declared field, coerce types, check enums
 * and ranges, fill required defaults, and reject missing required fields.
 * Without a spec (schema unavailable): use each request's first candidate,
 * coerced to the type the catalog normally declares for it.
 */
export function buildModelInput(
  spec: AtlasModelSpec | undefined,
  requests: FieldRequest[],
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...base };
  for (const req of requests) {
    if (req.value === undefined || (Array.isArray(req.value) && req.value.length === 0)) continue;
    if (!spec) {
      const field = req.candidates[0];
      if (field) {
        const type = FALLBACK_FIELD_TYPES[field] ?? "string";
        body[field] = coerce(req.flag, field, { type }, req.value);
      }
      continue;
    }
    const field = pickField(spec, req);
    if (!field) {
      throw new ValidationError(
        `Model ${spec.model} does not accept ${req.flag}. Its inputs: ${listInputs(spec)}. Use \`multix atlas run ${spec.model} --input '{...}'\` for model-specific fields.`,
      );
    }
    const prop = spec.properties[field] as AtlasSchemaProperty;
    const value = coerce(req.flag, field, prop, req.value);
    checkConstraints(req.flag, field, prop, value);
    body[field] = value;
  }
  if (spec) finalizeAgainstSpec(spec, body, requests);
  return body;
}

function listInputs(spec: AtlasModelSpec): string {
  return Object.keys(spec.properties)
    .filter((k) => k !== "model")
    .join(", ");
}

/**
 * Content fields whose schema "default" is only a playground example; filling
 * them would silently generate (and bill) something the user never asked for.
 */
const CONTENT_FIELDS = new Set(["prompt", "text", "lyrics"]);

/**
 * Fill required fields that have a schema default, then fail on any required
 * field still missing. `requests` maps field names back to flags for the hint.
 */
export function finalizeAgainstSpec(
  spec: AtlasModelSpec,
  body: Record<string, unknown>,
  requests: FieldRequest[] = [],
): void {
  const missing: string[] = [];
  for (const field of spec.required) {
    if (field === "model" || body[field] !== undefined) continue;
    const def = spec.properties[field]?.default;
    if (def !== undefined && def !== "" && !CONTENT_FIELDS.has(field)) {
      body[field] = def;
      continue;
    }
    const flag = requests.find((r) => r.candidates.includes(field))?.flag;
    missing.push(flag ? `${field} (pass ${flag})` : field);
  }
  if (missing.length > 0) {
    throw new ValidationError(`Model ${spec.model} requires: ${missing.join(", ")}`);
  }
}

/**
 * Validate a raw `run --input` payload against the model schema: enums and
 * ranges for declared fields, required fields present (defaults filled).
 * Returns the names of fields the schema does not declare (caller warns;
 * the schema may lag behind the live model).
 */
export function validateRawInput(spec: AtlasModelSpec, body: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (field === "model") continue;
    const prop = spec.properties[field];
    if (!prop) {
      unknown.push(field);
      continue;
    }
    checkConstraints(`--input.${field}`, field, prop, value);
  }
  finalizeAgainstSpec(spec, body);
  return unknown;
}
