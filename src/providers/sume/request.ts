/**
 * Build Sume generate bodies from command options. Shared by the commands and
 * the pre-flight quote, so the quote prices exactly the fields the command
 * sends. Options are read by long name in camelCase (commander) or kebab-case
 * (MCP callers), like src/budget/command-cost.ts.
 *
 * Runtime-neutral: media inputs arrive already resolved to https URLs (the
 * CLI uploads local files first).
 */

import { ValidationError } from "../../core/errors.js";
import type { SumeRequestBody } from "./types.js";

export type SumeRouter = "image" | "video";

type FieldKind = "string" | "int" | "bool" | "media" | "media-list";

interface FieldSpec {
  /** Request body field. */
  field: string;
  /** Long option name (kebab-case). */
  option: string;
  kind: FieldKind;
}

const IMAGE_FIELDS: readonly FieldSpec[] = [
  { field: "image_urls", option: "image", kind: "media-list" },
  { field: "aspect_ratio", option: "aspect-ratio", kind: "string" },
  { field: "image_size", option: "image-size", kind: "string" },
  { field: "quality", option: "quality", kind: "string" },
  { field: "resolution", option: "resolution", kind: "string" },
  { field: "num_images", option: "num-images", kind: "int" },
];

const VIDEO_FIELDS: readonly FieldSpec[] = [
  { field: "image_url", option: "image", kind: "media" },
  { field: "end_image_url", option: "end-image", kind: "media" },
  { field: "video_url", option: "video", kind: "media" },
  { field: "audio_url", option: "audio", kind: "media" },
  { field: "reference_image_urls", option: "reference-image", kind: "media-list" },
  { field: "duration", option: "duration", kind: "int" },
  { field: "resolution", option: "resolution", kind: "string" },
  { field: "aspect_ratio", option: "aspect-ratio", kind: "string" },
  { field: "generate_audio", option: "generate-audio", kind: "bool" },
];

export const ROUTER_FIELDS: Record<SumeRouter, readonly FieldSpec[]> = {
  image: IMAGE_FIELDS,
  video: VIDEO_FIELDS,
};

/** Fields `--input` may not set: the router picks `model` from `-m`. */
const RESERVED_INPUT_KEYS = new Set(["model"]);

type Options = Record<string, unknown>;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** An option by long name: camelCase, kebab-case, or spelled as a flag (`--image`). */
export function readOption(options: Options, name: string): unknown {
  for (const key of [camel(name), name, `--${name}`]) {
    if (options[key] !== undefined) return options[key];
  }
  return undefined;
}

function asString(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") throw new ValidationError(`${flag} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asInt(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(
      `${flag} must be a whole number of at least 1, got "${String(value)}"`,
    );
  }
  return n;
}

function asBool(value: unknown, flag: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ValidationError(`${flag} must be true or false`);
}

function asList(value: unknown, flag: string): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    const s = asString(item, flag);
    if (s === undefined) throw new ValidationError(`${flag} must not be empty`);
    return s;
  });
}

export interface MediaInput {
  field: string;
  flag: string;
  /** Paths or URLs as given. */
  values: string[];
  /** True when the field takes a list (`image_urls`, `reference_image_urls`). */
  list: boolean;
}

/** The media options a command was given, in field order, before upload. */
export function mediaInputs(router: SumeRouter, options: Options): MediaInput[] {
  return ROUTER_FIELDS[router].flatMap((spec) => {
    if (spec.kind !== "media" && spec.kind !== "media-list") return [];
    const flag = `--${spec.option}`;
    const values = asList(readOption(options, spec.option), flag);
    if (values.length === 0) return [];
    if (spec.kind === "media" && values.length > 1) {
      throw new ValidationError(`${flag} takes one file or URL, got ${values.length}`);
    }
    return [{ field: spec.field, flag, values, list: spec.kind === "media-list" }];
  });
}

/** Parse `--input` (a JSON object string, or an object from an MCP caller). */
export function parseExtraInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError(
        `--input must be a JSON object, e.g. '{"output_format":"png"}'; could not parse it`,
      );
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("--input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** `-m/--model`, required: multix never guesses a Sume model. */
export function requireModel(options: Options): string {
  const model = asString(readOption(options, "model"), "--model");
  if (!model) {
    throw new ValidationError(
      "Missing -m/--model. Pick a model id from `multix sume models` (multix does not choose one for you)",
    );
  }
  return model;
}

export interface BuildBodyOptions {
  prompt?: string;
  /** Resolved https URLs per media field; defaults to the option values as given. */
  media?: Record<string, string[]>;
}

/**
 * The generate body for `router`: `model`, the prompt, every typed option
 * that was set, and the `--input` fields. A field set both by a flag and by
 * `--input` is an error rather than a silent override.
 */
export function buildSumeBody(
  router: SumeRouter,
  options: Options,
  opts: BuildBodyOptions = {},
): SumeRequestBody {
  const model = requireModel(options);
  const body: SumeRequestBody = { model };
  const prompt = opts.prompt?.trim();
  if (prompt) body.prompt = prompt;
  const media = opts.media ?? {};
  const fromFlags = new Map<string, string>();
  if (prompt) fromFlags.set("prompt", "<prompt>");

  for (const spec of ROUTER_FIELDS[router]) {
    const flag = `--${spec.option}`;
    const raw = readOption(options, spec.option);
    let value: unknown;
    switch (spec.kind) {
      case "string":
        value = asString(raw, flag);
        break;
      case "int":
        value = asInt(raw, flag);
        break;
      case "bool":
        value = asBool(raw, flag);
        break;
      case "media":
      case "media-list": {
        const urls = media[spec.field] ?? asList(raw, flag);
        if (urls.length === 0) break;
        value = spec.kind === "media" ? urls[0] : urls;
        break;
      }
    }
    if (value === undefined) continue;
    body[spec.field] = value;
    fromFlags.set(spec.field, flag);
  }

  const extra = parseExtraInput(readOption(options, "input"));
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_INPUT_KEYS.has(key)) {
      throw new ValidationError(`--input may not set "${key}"; use -m/--model`);
    }
    const flag = fromFlags.get(key);
    if (flag) {
      throw new ValidationError(`"${key}" is set by both ${flag} and --input; keep one`);
    }
    body[key] = value;
  }
  return body;
}

/** The body without `model`: the `input` of an estimate request. */
export function estimateInput(body: SumeRequestBody): Record<string, unknown> {
  const { model: _model, ...input } = body;
  return input;
}
