/**
 * Validate a `multix_run` request against the CLI catalog and the command
 * policy, and build the argv the container passes to `execFile("multix")`.
 *
 * argv layout: `<group> <command…> --name=value … [-- positional…]`.
 * Values are always attached with `=`, so a value starting with `-` can never
 * be read as another flag; positionals come after `--` for the same reason.
 * No shell is involved, so quoting is not a concern.
 */

import { ValidationError } from "../../../src/core/errors.js";
import type { Limits } from "../config.js";
import { assertPublicHttpsUrl } from "../url-guard.js";
import type { CliOption } from "./cli-catalog-types.js";
import { CatalogIndex, isRepeatable, normaliseCommand, optionName } from "./cli-catalog.js";
import {
  type CommandPolicy,
  GLOBALLY_UNSUPPORTED_OPTIONS,
  OUTPUT_DIR_OPTION,
  OUTPUT_FILE_OPTION,
  policyFor,
} from "./cli-command-policy.js";
import type { JobInputFile } from "./job-protocol.js";
import { type FileTarget, resolveInputs } from "./run-input-files.js";
import {
  type OptionValues,
  applyCaps,
  assertAllowedImageModel,
  uncappedReason,
} from "./run-option-caps.js";

export type RunOptionValue = string | number | boolean | string[];

export interface RunRequest {
  command: string;
  args?: string[];
  options?: Record<string, RunOptionValue>;
  inputs?: Record<string, string | string[]>;
}

export interface PreparedRun {
  /** Normalised command path, e.g. `gemini generate`. */
  command: string;
  group: string;
  /** Provider groups whose keys the job receives. */
  keyGroups: string[];
  argv: string[];
  inputs: JobInputFile[];
  /** Why the operator caps cannot bound this run (see assertSpendGuard); undefined when they do. */
  uncappedSpend?: string;
}

/** Longest single option or positional value. */
export const MAX_VALUE_CHARS = 16_000;
/** Directory (relative to the job directory) the CLI writes outputs to. */
export const OUTPUT_DIR = "out";

const OPTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const OUTPUT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ASSET_REF_RE = /^asset:[A-Za-z0-9_-]{1,128}$/;
/** Values the CLI turns into part of a file name (see CommandPolicy.nameOptions). */
export const NAME_PART_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A model-parameter token such as `--dur` (see CommandPolicy.promptFlagOptions). */
const PROMPT_FLAG_RE = /--[a-z]/i;

const defaultIndex = new CatalogIndex();

function keyGroupsFor(
  path: string,
  group: string,
  policy: CommandPolicy,
  values: OptionValues,
): string[] {
  const rule = policy.keyOptions;
  if (!rule) return [group];
  const [first] = rule.options;
  if (first && !values.has(first)) {
    throw new ValidationError(`options.${first} is required for "${path}" on this server`);
  }
  const groups = new Set<string>();
  for (const name of rule.options) {
    const value = values.get(name);
    for (const v of value === true || value === undefined ? [] : value) {
      const named = v.split(":")[0] ?? "";
      if (!rule.groups.includes(named)) {
        throw new ValidationError(`--${name} must name one of: ${rule.groups.join(", ")}`);
      }
      groups.add(named);
    }
  }
  return [...groups];
}

function checkText(value: string, field: string): string {
  if (value.length > MAX_VALUE_CHARS) {
    throw new ValidationError(`${field} must be at most ${MAX_VALUE_CHARS} characters`);
  }
  if (value.startsWith("@")) {
    throw new ValidationError(`${field} must not reference a file with @; use inputs for files`);
  }
  if (value.includes("\0")) throw new ValidationError(`${field} must not contain NUL characters`);
  return value;
}

function scalar(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return checkText(value, field);
  throw new ValidationError(`${field} must be a string or a number`);
}

function optionValue(
  option: CliOption,
  name: string,
  raw: RunOptionValue,
  repeatable: boolean,
): string[] | true | null {
  const field = `--${name}`;
  if (!option.takesValue) {
    if (typeof raw !== "boolean")
      throw new ValidationError(`${field} is a flag: pass true or false`);
    return raw ? true : null;
  }
  if (raw === true && option.valueOptional) return true;
  if (typeof raw === "boolean") throw new ValidationError(`${field} takes a value`);
  if (Array.isArray(raw)) {
    if (!repeatable) throw new ValidationError(`${field} takes a single value`);
    return raw.map((v, i) => scalar(v, `${field}[${i}]`));
  }
  return [scalar(raw, field)];
}

export function prepareRun(
  request: RunRequest,
  limits: Limits,
  index: CatalogIndex = defaultIndex,
): PreparedRun {
  const path = normaliseCommand(request.command);
  const entry = index.find(path);
  if (!entry) throw new ValidationError(`Unknown command "${path}"; call multix_catalog`);
  if (!index.isRunnable(path)) throw new ValidationError(`"${path}" cannot run on this server`);
  const { command, group } = entry;
  const policy = policyFor(path);
  const options = new Map(command.options.map((o) => [optionName(o), o]));

  const targets = new Map<string, FileTarget>();
  for (const [name, kind] of Object.entries(policy.fileOptions ?? {})) {
    const option = options.get(name);
    if (option) {
      targets.set(name, { kind, multiple: kind === "dir" || isRepeatable(option, policy) });
    }
  }
  for (const name of policy.filePositionals ?? []) {
    const positional = command.positionals.find((p) => p.name === name);
    if (positional) targets.set(name, { kind: "file", multiple: positional.variadic });
  }
  const resolved = resolveInputs(request.inputs, targets);

  const values: OptionValues = new Map();
  const unsupported = new Set([...GLOBALLY_UNSUPPORTED_OPTIONS, ...(policy.unsupported ?? [])]);
  const assetRefs = new Set(policy.assetRefOptions ?? []);
  const urlOptions = new Set(policy.urlOptions ?? []);
  const nameOptions = new Set(policy.nameOptions ?? []);
  const promptFlagOptions = new Set(policy.promptFlagOptions ?? []);
  for (const [rawName, raw] of Object.entries(request.options ?? {})) {
    const name = rawName.replace(/^-+/, "");
    const option = OPTION_NAME_RE.test(name) ? options.get(name) : undefined;
    if (!option) throw new ValidationError(`Unknown option --${name} for "${path}"`);
    if (unsupported.has(name) || name === OUTPUT_DIR_OPTION) {
      throw new ValidationError(`--${name} is not available on this server`);
    }
    if (resolved.paths.has(name)) {
      throw new ValidationError(`--${name} is given in inputs; do not repeat it in options`);
    }
    const forced = policy.forced?.[name];
    if (forced !== undefined) {
      if (raw !== forced) throw new ValidationError(`--${name} must be ${forced} on this server`);
      continue;
    }
    const value = optionValue(option, name, raw, isRepeatable(option, policy));
    if (value === null) continue;
    if (nameOptions.has(name) && value !== true && !value.every((v) => NAME_PART_RE.test(v))) {
      throw new ValidationError(`--${name} may contain only letters, digits, _ and - (at most 64)`);
    }
    const allowed = policy.allowedValues?.[name];
    if (allowed && value !== true && !value.every((v) => allowed.includes(v))) {
      throw new ValidationError(`--${name} must be one of ${allowed.join(", ")} on this server`);
    }
    if (
      promptFlagOptions.has(name) &&
      value !== true &&
      value.some((v) => PROMPT_FLAG_RE.test(v))
    ) {
      throw new ValidationError(
        `--${name} may not contain "--" followed by a letter: the provider reads such text as a model parameter (e.g. --dur), so use the command's own options`,
      );
    }
    if (targets.has(name)) {
      const refs = value === true ? [] : value;
      if (!assetRefs.has(name) || refs.length === 0 || !refs.every((v) => ASSET_REF_RE.test(v))) {
        throw new ValidationError(`--${name} is a file: pass its https URL in inputs.${name}`);
      }
    }
    if (urlOptions.has(name) && value !== true) {
      value.forEach((v, i) => {
        value[i] = assertPublicHttpsUrl(v, `--${name}`);
      });
    }
    if (name === OUTPUT_FILE_OPTION && value !== true) {
      if (value.length !== 1 || !OUTPUT_FILE_RE.test(value[0] ?? "") || value[0]?.includes("..")) {
        throw new ValidationError(`--${name} must be a plain file name such as result.png`);
      }
      values.set(name, [`${OUTPUT_DIR}/${value[0]}`]);
      continue;
    }
    values.set(name, value);
  }
  for (const [name, paths] of resolved.paths) {
    if (options.has(name)) values.set(name, paths);
  }
  for (const [name, forced] of Object.entries(policy.forced ?? {})) values.set(name, [forced]);
  if (options.has(OUTPUT_DIR_OPTION)) values.set(OUTPUT_DIR_OPTION, [OUTPUT_DIR]);
  applyCaps(policy.caps, options, values, limits);
  assertAllowedImageModel(path, group, options, values, limits);

  for (const [name, option] of options) {
    if (option.required && !values.has(name)) {
      const where = targets.has(name) ? `inputs.${name}` : `options.${name}`;
      throw new ValidationError(`${where} is required for "${path}"`);
    }
  }

  const keyGroups = keyGroupsFor(path, group, policy, values);
  const positionals = positionalValues(path, command.positionals, request.args, {
    paths: resolved.paths,
    targets,
    assetRefs,
  });
  const argv = [...path.split(" ")];
  for (const [name, value] of values) {
    if (value === true) argv.push(`--${name}`);
    else for (const v of value) argv.push(`--${name}=${v}`);
  }
  if (positionals.length > 0) argv.push("--", ...positionals);
  const uncappedSpend = uncappedReason(policy, options, values, limits);
  return {
    command: path,
    group,
    keyGroups,
    argv,
    inputs: resolved.files,
    ...(uncappedSpend ? { uncappedSpend } : {}),
  };
}

interface PositionalFiles {
  paths: ReadonlyMap<string, string[]>;
  targets: ReadonlyMap<string, FileTarget>;
  assetRefs: ReadonlySet<string>;
}

/**
 * Plain positionals from `args` in declared order; file positionals from
 * `inputs` (or, where the provider accepts one, an `asset:<id>` in `args`).
 */
function positionalValues(
  path: string,
  declared: readonly { name: string; required: boolean; variadic: boolean }[],
  args: readonly unknown[] | undefined,
  files: PositionalFiles,
): string[] {
  const queue = [...(args ?? [])];
  const out: string[] = [];
  for (const positional of declared) {
    const downloaded = files.paths.get(positional.name);
    if (downloaded) {
      out.push(...downloaded);
      continue;
    }
    const isFile = files.targets.has(positional.name);
    const take = positional.variadic ? queue.splice(0) : queue.splice(0, 1);
    if (take.length === 0) {
      if (positional.required) {
        const where = isFile ? `inputs.${positional.name}` : `Positional <${positional.name}>`;
        throw new ValidationError(`${where} is required for "${path}"`);
      }
      break;
    }
    const values = take.map((v, i) => scalar(v, `args[${out.length + i}]`));
    if (
      isFile &&
      !(files.assetRefs.has(positional.name) && values.every((v) => ASSET_REF_RE.test(v)))
    ) {
      throw new ValidationError(
        `<${positional.name}> is a file: pass its https URL in inputs.${positional.name}`,
      );
    }
    out.push(...values);
  }
  if (queue.length > 0) throw new ValidationError(`Too many args for "${path}"`);
  return out;
}
