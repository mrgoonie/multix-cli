/**
 * Spend limits for Atlas Cloud video requests.
 *
 * The Atlas API fills any field left out of a request from the model's
 * schema default, so length and size are bounded by sending every length
 * field explicitly and by checking what will actually be rendered, schema
 * defaults included. Other price multipliers (audio and reasoning switches,
 * output count, known price tiers) are sent at their cheapest values. Shapes
 * this code cannot interpret fail closed.
 */

import { ValidationError } from "../../../src/core/errors.js";
import {
  FIELD_CANDIDATES as F,
  type FieldRequest,
} from "../../../src/providers/atlascloud/model-input.js";
import type {
  AtlasModelSpec,
  AtlasSchemaProperty,
} from "../../../src/providers/atlascloud/types.js";

export interface VideoPolicy {
  maxSeconds: number;
  /** Seconds used when the caller omitted `duration` and the schema has no usable default. */
  fallbackSeconds: number;
  /** The caller's duration, or undefined when omitted. */
  requestedSeconds?: number;
  /** Lower-case resolutions this server allows. */
  allowedResolutions: string[];
}

type Prop = AtlasSchemaProperty & {
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
  $ref?: unknown;
};

/** Fields that set a video's length in seconds, in preference order. */
const SECONDS_FIELDS = ["duration", "seconds", "length", "num_seconds", "video_length"];
/** Fields that set a video's length in frames. */
const FRAME_FIELDS = ["num_frames", "frames"];
const FPS_FIELDS = ["fps", "frames_per_second"];
/**
 * Any other numeric field with one of these words in its name is a length
 * this code cannot cap (frame_count, num_frame, clip_length, video_len, ...).
 */
const LENGTH_LIKE_RE = /frame|second|duration|length|_len$/i;
const SIZE_FIELDS = ["size", "video_size"];
const DIMENSION_FIELDS = ["width", "height"];

/**
 * Switches that add a billed feature when on: an audio track
 * (generate_audio, sound, audio), prompt reasoning (enable_thinking) or HDR
 * output (hdr). The MCP tool has no argument for them, so they are always
 * sent off. A string `audio` with no default is an input URL, not a switch.
 */
const COST_TOGGLES = ["generate_audio", "sound", "audio", "enable_thinking", "hdr"];
/** Enum values that mean "off" for a cost switch declared as a string enum. */
const OFF_VALUES = ["false", "no", "off", "none", "disabled"];
/** Fields that set how many videos one call generates; always sent as 1. */
const OUTPUT_COUNT_RE =
  /^(n|count|batch_size|batch_count)$|^num_(outputs?|videos?|samples?|generations?|results?)$|^(outputs?|videos?|samples?|generations?)_count$/i;
/**
 * Price tier ladders by field, each cheapest first. A field may have several
 * independent ladders; the one holding the schema's values is used. Only
 * values listed here are ordered; any other value is unknown. "default"
 * thinking is treated as above medium.
 */
const PRICE_TIERS: Record<string, readonly (readonly string[])[]> = {
  thinking_level: [["minimal", "low", "medium", "default", "high"]],
  motion: [["low", "medium", "high"]],
  bitrate_mode: [["standard", "high"]],
  mode: [
    ["wan-std", "wan-pro"],
    ["std", "pro"],
    ["standard", "professional"],
  ],
};

/** "8", 8, "8s" or "8 seconds" -> 8. */
function parseSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?\s*$/i.exec(value);
  return m ? Number(m[1]) : undefined;
}

/**
 * Collapse an `anyOf`/`oneOf` with one non-null member (recursively);
 * undefined when the shape is ambiguous or holds a `$ref`/`allOf` at any level.
 */
function unwrap(prop: Prop | undefined): Prop | undefined {
  if (!prop) return undefined;
  if (prop.$ref !== undefined || prop.allOf !== undefined) return undefined;
  const alternatives = prop.anyOf ?? prop.oneOf;
  if (alternatives === undefined) return prop;
  if (!Array.isArray(alternatives)) return undefined;
  const members = alternatives.filter(
    (m): m is Prop => Boolean(m) && typeof m === "object" && (m as Prop).type !== "null",
  );
  if (members.length !== 1) return undefined;
  const { anyOf: _a, oneOf: _o, ...outer } = prop;
  return unwrap({ ...members[0], ...outer });
}

/** True when the property holds a number (by type, an all-numeric enum, or a numeric default). */
function isNumeric(prop: Prop | undefined): prop is Prop {
  if (!prop) return false;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.every((e) => parseSeconds(e) !== undefined);
  }
  if (prop.type === "integer" || prop.type === "number") return true;
  return (
    (prop.type === undefined || prop.type === "string") && parseSeconds(prop.default) !== undefined
  );
}

/** The value to send for `n`: the matching enum entry, or the schema's string format. */
function formatFor(prop: Prop, n: number): string | number {
  if (Array.isArray(prop.enum)) {
    const match = prop.enum.find((e) => parseSeconds(e) === n);
    if (typeof match === "string" || typeof match === "number") return match;
  }
  if (prop.type === "string") {
    return `${n}${typeof prop.default === "string" && /\d\s*s/i.test(prop.default) ? "s" : ""}`;
  }
  return n;
}

/**
 * The largest allowed value at or below `target`, else the smallest allowed
 * value up to `hi`. Allowed values are the enum, or the schema range clamped
 * to at least 1: zero and negative lengths (often "auto") are never chosen.
 */
function snap(prop: Prop, target: number, hi: number): number | undefined {
  const lo = Math.max(prop.minimum ?? 1, 1);
  const top = Math.min(prop.maximum ?? hi, hi);
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const fitting = prop.enum
      .map(parseSeconds)
      .filter((n): n is number => n !== undefined && n >= lo && n <= top)
      .sort((a, b) => a - b);
    return fitting.filter((n) => n <= target).pop() ?? fitting[0];
  }
  if (lo > top) return undefined;
  const clamped = Math.min(Math.max(target, lo), top);
  const value = prop.type === "integer" ? Math.floor(clamped) : clamped;
  return value >= lo ? value : undefined;
}

function noFit(model: string, field: string, policy: VideoPolicy): ValidationError {
  return new ValidationError(
    `Model ${model}: field "${field}" has no allowed value within this server's cap of ${policy.maxSeconds}s`,
  );
}

/**
 * Seconds for a field the caller did not set: the schema default when it is
 * within the cap, the cap when the default is longer, or the server fallback
 * when there is no positive default; then snapped to the allowed values.
 */
function secondsToSend(model: string, field: string, prop: Prop, policy: VideoPolicy): number {
  const def = parseSeconds(prop.default);
  const target =
    def === undefined || def <= 0 ? policy.fallbackSeconds : Math.min(def, policy.maxSeconds);
  const value = snap(prop, target, policy.maxSeconds);
  if (value === undefined) throw noFit(model, field, policy);
  return value;
}

/** Frames per second the model will render at, from the schema default, if declared. */
function schemaFps(spec: AtlasModelSpec): number | undefined {
  for (const field of FPS_FIELDS) {
    const fps = parseSeconds(unwrap(spec.properties[field] as Prop)?.default);
    if (fps !== undefined && fps > 0) return fps;
  }
  return undefined;
}

/**
 * Most frames allowed under the cap. Without a declared frame rate the worst
 * case (one frame per second) is assumed, so only frame counts that are
 * clearly within the cap pass.
 */
function maxFrames(fps: number | undefined, policy: VideoPolicy): number {
  return fps === undefined ? policy.maxSeconds : Math.floor(policy.maxSeconds * fps);
}

/**
 * Frames for a frame-count field: the schema default when within the cap,
 * otherwise the most frames the cap allows (only when the frame rate is
 * known); then snapped to the allowed values.
 */
function framesToSend(
  model: string,
  field: string,
  prop: Prop,
  fps: number | undefined,
  policy: VideoPolicy,
): number {
  const limit = maxFrames(fps, policy);
  const def = parseSeconds(prop.default);
  let target: number | undefined;
  if (def !== undefined && def > 0)
    target = fps === undefined && def > limit ? undefined : Math.min(def, limit);
  else if (fps !== undefined) target = Math.floor(policy.fallbackSeconds * fps);
  const value = target === undefined ? undefined : snap(prop, target, limit);
  if (value === undefined) throw noFit(model, field, policy);
  return value;
}

/**
 * Length requests for a video. The caller's duration goes to the first
 * seconds field the schema declares; every other seconds or frame-count field
 * is sent explicitly, so the API never fills a longer default. A length field
 * this code cannot interpret, or any other length-like field, is rejected.
 */
export function lengthRequests(
  spec: AtlasModelSpec,
  model: string,
  policy: VideoPolicy,
): FieldRequest[] {
  for (const [name, raw] of Object.entries(spec.properties)) {
    const known = [...SECONDS_FIELDS, ...FRAME_FIELDS, ...FPS_FIELDS].includes(name);
    if (known || !LENGTH_LIKE_RE.test(name)) continue;
    // Image or flag inputs such as first_frame or return_last_frame are not lengths.
    const prop = unwrap(raw as Prop);
    if (prop === undefined || isNumeric(prop)) {
      throw new ValidationError(
        `Model ${model} has a length input "${name}" this server cannot cap; use a model whose length is set by duration`,
      );
    }
  }
  const declared = (fields: string[]) =>
    fields
      .filter((name) => spec.properties[name] !== undefined)
      .map((name) => {
        const prop = unwrap(spec.properties[name] as Prop);
        if (!isNumeric(prop)) {
          throw new ValidationError(
            `Model ${model}: length input "${name}" has a type this server cannot check`,
          );
        }
        return { name, prop };
      });
  const seconds = declared(SECONDS_FIELDS);
  const frames = declared(FRAME_FIELDS);
  const requested = policy.requestedSeconds;
  const requests: FieldRequest[] = seconds.map(({ name, prop }, i) => ({
    flag: "duration",
    value: formatFor(
      prop,
      i === 0 && requested !== undefined ? requested : secondsToSend(model, name, prop, policy),
    ),
    candidates: [name],
  }));
  const fps = schemaFps(spec);
  for (const { name, prop } of frames) {
    requests.push({
      flag: "duration",
      value: formatFor(prop, framesToSend(model, name, prop, fps, policy)),
      candidates: [name],
    });
  }
  // A requested duration on a model without a seconds field fails with "does not accept".
  if (seconds.length === 0 && requested !== undefined) {
    requests.push({ flag: "duration", value: requested, candidates: F.duration });
  }
  return requests;
}

/** Off value for a cost switch; undefined when the field is not a switch the API would fill. */
function offValue(prop: Prop): string | boolean | undefined | null {
  if (prop.type === "boolean" || typeof prop.default === "boolean") return false;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const off = prop.enum.find((e) => OFF_VALUES.includes(String(e).toLowerCase()));
    return typeof off === "string" || typeof off === "boolean" ? off : null;
  }
  // No default: nothing is filled in (for example an `audio` input URL).
  return prop.default === undefined ? undefined : null;
}

/** 1 in the schema's format, or undefined when the schema does not allow 1. */
function oneOutput(prop: Prop): string | number | undefined {
  if (!isNumeric(prop)) return undefined;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.some((e) => parseSeconds(e) === 1) ? formatFor(prop, 1) : undefined;
  }
  if ((prop.minimum ?? 1) > 1 || (prop.maximum ?? 1) < 1) return undefined;
  return formatFor(prop, 1);
}

/**
 * Cheapest tier to send, undefined to leave the field alone, or null to reject.
 * Sends the cheapest listed value of the enum when its order is known: every
 * enum value is listed, or the default is listed (so the pick costs no more
 * than the default). Without that, a listed default above the cheapest tier
 * is rejected; an unknown or missing default is left alone. The ladder used
 * is the one holding the default, else the first holding an enum value.
 */
function cheapestTier(
  prop: Prop,
  ladders: readonly (readonly string[])[],
): string | undefined | null {
  const holds = (ladder: readonly string[], v: unknown) =>
    typeof v === "string" && ladder.includes(v.toLowerCase());
  const values = Array.isArray(prop.enum) ? prop.enum : [];
  const tiers =
    ladders.find((l) => holds(l, prop.default)) ??
    ladders.find((l) => values.some((e) => holds(l, e)));
  if (tiers === undefined) return undefined;
  const rank = (v: unknown) => (typeof v === "string" ? tiers.indexOf(v.toLowerCase()) : -1);
  const known = values.filter((e) => rank(e) >= 0);
  const defaultRank = rank(prop.default);
  if (known.length > 0) {
    const ordered = known.length === prop.enum?.length || defaultRank >= 0;
    if (ordered) return known.reduce((a, b) => (rank(b) < rank(a) ? b : a)) as string;
  }
  return defaultRank > 0 ? null : undefined;
}

/**
 * Inputs other than length and size that multiply the price, pinned to their
 * cheapest values because the API fills omitted fields from schema defaults
 * (often audio on, or a higher tier): cost switches off, output count 1, and
 * known price tiers at the lowest tier. A field whose schema cannot be read,
 * or that has no cheap value this code can choose, is rejected.
 */
export function priceRequests(spec: AtlasModelSpec, model: string): FieldRequest[] {
  const requests: FieldRequest[] = [];
  for (const [name, raw] of Object.entries(spec.properties)) {
    const toggle = COST_TOGGLES.includes(name);
    const count = OUTPUT_COUNT_RE.test(name);
    const tiers = PRICE_TIERS[name];
    if (!toggle && !count && !tiers) continue;
    const prop = unwrap(raw as Prop);
    let value: string | number | boolean | undefined | null = null;
    if (prop !== undefined) {
      if (toggle) value = offValue(prop);
      else if (count) value = oneOutput(prop) ?? null;
      else if (tiers) value = cheapestTier(prop, tiers);
    }
    if (value === null) {
      const why =
        prop === undefined
          ? "has a schema that cannot be read"
          : count
            ? "cannot be set to one output"
            : toggle
              ? "cannot be switched off"
              : "cannot be set to its lowest price tier";
      throw new ValidationError(
        `Model ${model}: input "${name}" raises the price and ${why} by this server; use another model`,
      );
    }
    if (value !== undefined) requests.push({ flag: name, value, candidates: [name] });
  }
  return requests;
}

/**
 * Largest frame allowed by the resolution allowlist, as long and short side
 * (e.g. 1080p -> 1920 x 1080), if any entry parses.
 */
function maxBox(allowed: string[]): { long: number; short: number } | undefined {
  const shortSides = allowed
    .map((r) => {
      const p = /^(\d{3,4})p$/.exec(r);
      if (p) return Number(p[1]);
      return r === "2k" ? 1440 : r === "4k" ? 2160 : undefined;
    })
    .filter((n): n is number => n !== undefined);
  if (shortSides.length === 0) return undefined;
  const short = Math.max(...shortSides);
  return { long: Math.ceil((short * 16) / 9), short };
}

/**
 * What the API will use for a field: the value sent, else the schema default
 * it fills in. A schema shape this code cannot read ($ref, allOf, an anyOf or
 * oneOf with several members) is trusted only for an outer default next to a
 * union; anything else is rejected rather than skipped.
 */
function effective(
  spec: AtlasModelSpec,
  model: string,
  body: Record<string, unknown>,
  field: string,
): unknown {
  if (body[field] !== undefined) return body[field];
  const raw = spec.properties[field] as Prop | undefined;
  if (raw === undefined) return undefined;
  const prop = unwrap(raw);
  if (prop !== undefined) return prop.default;
  if (raw.$ref === undefined && raw.allOf === undefined && raw.default !== undefined) {
    return raw.default;
  }
  // Only resolution is a tool argument; size and dimensions cannot be passed.
  const remedy = (F.resolution as readonly string[]).includes(field)
    ? "pass a resolution or use another model"
    : "use another model";
  throw new ValidationError(
    `Model ${model}: input "${field}" has a schema this server cannot check; ${remedy}`,
  );
}

/** Re-check what will actually be billed, including schema defaults the API fills in. */
export function assertVideoBodyWithinLimits(
  spec: AtlasModelSpec,
  model: string,
  body: Record<string, unknown>,
  policy: VideoPolicy,
): void {
  const tooLong = (seconds: number) =>
    new ValidationError(
      `Model ${model} would render ${seconds}s; this server allows at most ${policy.maxSeconds}s`,
    );
  for (const field of SECONDS_FIELDS) {
    const seconds = parseSeconds(effective(spec, model, body, field));
    if (seconds !== undefined && seconds > policy.maxSeconds) throw tooLong(seconds);
  }
  const fps = schemaFps(spec);
  for (const field of FRAME_FIELDS) {
    const frames = parseSeconds(effective(spec, model, body, field));
    if (frames !== undefined && frames > maxFrames(fps, policy)) {
      throw tooLong(fps === undefined ? frames : frames / fps);
    }
  }

  for (const field of F.resolution) {
    const resolution = effective(spec, model, body, field);
    if (resolution === undefined || resolution === "") continue;
    if (
      typeof resolution !== "string" ||
      !policy.allowedResolutions.includes(resolution.toLowerCase())
    ) {
      throw new ValidationError(
        `Model ${model} would render at ${String(resolution)}; pass a resolution this server allows (${policy.allowedResolutions.join(", ")})`,
      );
    }
  }

  const box = maxBox(policy.allowedResolutions);
  const sizeError = (value: unknown) =>
    new ValidationError(
      `Model ${model} would render at size ${String(value)}; this server allows at most ${box ? `${box.long}x${box.short}` : "?"} pixels`,
    );
  /** Both sides fit the box in either orientation: long side <= long edge, short side <= short edge. */
  const fits = (a: number, b: number) =>
    box !== undefined && Math.max(a, b) <= box.long && Math.min(a, b) <= box.short;
  for (const field of SIZE_FIELDS) {
    const size = effective(spec, model, body, field);
    if (size === undefined || size === "") continue;
    const m = typeof size === "string" ? /^\s*(\d+)\s*[x*×]\s*(\d+)\s*$/i.exec(size) : null;
    if (!m || !fits(Number(m[1]), Number(m[2]))) throw sizeError(size);
  }
  const sides: number[] = [];
  for (const field of DIMENSION_FIELDS) {
    const value = effective(spec, model, body, field);
    if (value === undefined) continue;
    const pixels = parseSeconds(value);
    if (pixels === undefined || box === undefined || pixels > box.long) throw sizeError(value);
    sides.push(pixels);
  }
  const [first, second] = sides;
  if (first !== undefined && second !== undefined && !fits(first, second)) {
    throw sizeError(sides.join("x"));
  }
}
