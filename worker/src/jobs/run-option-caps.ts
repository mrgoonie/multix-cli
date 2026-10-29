/**
 * Operator caps for `multix_run`, the same limits the Worker's own image and
 * video tools enforce (MULTIX_MCP_MAX_OUTPUTS, MULTIX_MCP_MAX_VIDEO_SECONDS,
 * MULTIX_MCP_ALLOWED_RESOLUTIONS), plus MULTIX_MCP_MAX_AUDIO_SECONDS for
 * generated audio. Applied to the value the CLI would really
 * use: the caller's value, or else the CLI default.
 */

import { ValidationError } from "../../../src/core/errors.js";
import type { Limits } from "../config.js";
import type { CliOption } from "./cli-catalog-types.js";
import type { CapRules, CommandPolicy } from "./cli-command-policy.js";

/** Values per option name after validation: strings, or `true` for a bare flag. */
export type OptionValues = Map<string, string[] | true>;

function single(values: OptionValues, name: string): string | undefined {
  const value = values.get(name);
  return Array.isArray(value) ? value[0] : undefined;
}

function defaultString(option: CliOption | undefined): string | undefined {
  const value = option?.default;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** `720p`, `1080P` and `RESOLUTION_720` all normalise to `720p`; other forms are kept lower-cased. */
export function normaliseResolution(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const digits = /^(?:resolution_)?(\d{3,4})p?$/.exec(lower);
  return digits ? `${digits[1]}p` : lower;
}

function positiveNumber(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new ValidationError(`--${name} must be a positive number`);
  return n;
}

/**
 * Check caps and, where the CLI default could exceed the duration cap, set
 * the server default instead. Mutates `values`.
 */
export function applyCaps(
  rules: CapRules | undefined,
  options: ReadonlyMap<string, CliOption>,
  values: OptionValues,
  limits: Limits,
): void {
  for (const name of rules?.count ?? []) {
    const raw = single(values, name) ?? defaultString(options.get(name));
    if (raw !== undefined && positiveNumber(raw, name) > limits.maxOutputs) {
      throw new ValidationError(`--${name} must be at most ${limits.maxOutputs} on this server`);
    }
  }
  for (const name of rules?.duration ?? []) {
    const given = single(values, name);
    if (given !== undefined) {
      if (positiveNumber(given, name) > limits.maxVideoSeconds) {
        throw new ValidationError(
          `--${name} must be at most ${limits.maxVideoSeconds} seconds on this server`,
        );
      }
      continue;
    }
    const fallback = defaultString(options.get(name));
    const fallbackSeconds = fallback === undefined ? Number.NaN : Number(fallback);
    if (!(fallbackSeconds > 0 && fallbackSeconds <= limits.maxVideoSeconds)) {
      // Unknown or too-long provider default: send the server default instead.
      values.set(name, [String(limits.defaultVideoSeconds)]);
    }
  }
  for (const rule of rules?.audioLength ?? []) {
    const { option: name, unitsPerSecond, omittedSeconds, notWith } = rule;
    const given = single(values, name);
    const maxUnits = limits.maxAudioSeconds * unitsPerSecond;
    if (given !== undefined) {
      if (positiveNumber(given, name) > maxUnits) {
        throw new ValidationError(
          `--${name} must be at most ${maxUnits} (${limits.maxAudioSeconds} seconds) on this server`,
        );
      }
    } else if (
      omittedSeconds > limits.maxAudioSeconds &&
      !notWith?.some((other) => values.has(other))
    ) {
      // The provider's own length could exceed the cap: send the cap instead.
      values.set(name, [String(maxUnits)]);
    }
  }
  for (const name of rules?.resolution ?? []) {
    if (
      rules?.fillResolution &&
      single(values, name) === undefined &&
      !defaultString(options.get(name))
    ) {
      // No value the CLI would check: send an allowed one (720p when the operator allows it).
      const fill = limits.allowedResolutions.includes("720p")
        ? "720p"
        : limits.allowedResolutions[0];
      if (fill) values.set(name, [fill]);
    }
    const raw = single(values, name) ?? defaultString(options.get(name));
    if (raw !== undefined && !limits.allowedResolutions.includes(normaliseResolution(raw))) {
      throw new ValidationError(
        `--${name} must be one of ${limits.allowedResolutions.join(", ")} on this server`,
      );
    }
  }
}

/**
 * Why the caps cannot bound this run, or undefined when they do: the command
 * is marked uncapped, the caller used an option that merges a raw request
 * body, or the model picks the number of outputs or the resolution.
 */
export function uncappedReason(
  policy: CommandPolicy,
  values: OptionValues,
  limits: Limits,
): string | undefined {
  if (policy.uncappedSpend) return policy.uncappedSpend;
  const merged = policy.uncappedOptions?.find((name) => values.has(name));
  if (merged) return `with --${merged}, the server caps do not bound the request`;
  if (policy.caps?.countFromModel) {
    const omitted = policy.caps.count?.find((name) => !values.has(name));
    if (omitted) {
      return `--${omitted} is omitted, so the model picks the number of outputs (pass --${omitted}, at most ${limits.maxOutputs})`;
    }
  }
  if (policy.caps?.resolutionFromModel) {
    const omitted = policy.caps.resolution?.find((name) => !values.has(name));
    if (omitted) {
      return `--${omitted} is omitted, so the model picks the resolution (pass --${omitted}: ${limits.allowedResolutions.join(", ")})`;
    }
  }
  return undefined;
}

/**
 * Apply MULTIX_MCP_UNCAPPED_SPEND to a run the caps cannot bound. In `budget`
 * mode the caller must give max_cost_usd; the cost check then refuses any run
 * whose price is unknown or above it, so the run is bounded or never starts.
 */
export function assertSpendGuard(
  command: string,
  reason: string | undefined,
  limits: Limits,
  maxCostUsd: number | undefined,
): void {
  if (reason === undefined || limits.uncappedSpend === "allow") return;
  const why = `"${command}" is not bounded by this server's caps: ${reason}`;
  if (limits.uncappedSpend === "deny") {
    throw new ValidationError(`${why}. This server does not run such commands.`);
  }
  if (maxCostUsd === undefined) {
    throw new ValidationError(
      `${why}. Pass max_cost_usd: the run starts only when its price is known and fits, so a command without a price estimate is refused.`,
    );
  }
}
