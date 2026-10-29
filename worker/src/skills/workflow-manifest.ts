/**
 * A skill's workflow manifest (`multix.workflow.json`): a short, fixed list
 * of multix CLI steps with typed inputs. It describes what a run does; it
 * never runs anything by itself (see workflow-manager.ts for the authorized
 * runner).
 *
 *   {
 *     "version": 1,
 *     "description": "Draw a product shot, then restyle it",
 *     "inputs": { "subject": { "type": "string", "required": true, "max_length": 500 } },
 *     "steps": [
 *       { "id": "draw", "command": "gemini generate", "options": { "prompt": "{{inputs.subject}}" } },
 *       { "id": "restyle", "command": "gemini image-to-image",
 *         "options": { "prompt": "watercolor" }, "inputs": { "ref": "{{steps.draw.outputs[0]}}" } }
 *     ]
 *   }
 *
 * Templates appear only in values (`args`, option values, `inputs` URLs),
 * never in command paths or option names, and every rendered value stays one
 * argv element, so a value cannot add a flag or an argument.
 */

import { ValidationError } from "../../../src/core/errors.js";
import { CatalogIndex, normaliseCommand } from "../jobs/cli-catalog.js";
import { MAX_VALUE_CHARS, type RunOptionValue, type RunRequest } from "../jobs/run-argv-builder.js";
import { MAX_INPUT_FILES } from "../jobs/run-input-files.js";
import { assertPublicHttpsUrl } from "../url-guard.js";

export const WORKFLOW_FILE = "multix.workflow.json";
export const MAX_WORKFLOW_BYTES = 64 * 1024;
export const MAX_WORKFLOW_STEPS = 10;
export const MAX_WORKFLOW_INPUTS = 20;
const MAX_ARGS = 20;
const MAX_OPTIONS = 40;
const MAX_LIST = 20;
const MAX_ENUM = 50;
const MAX_DESCRIPTION = 500;
/** Highest output index a step may reference. */
const MAX_OUTPUT_INDEX = 99;

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const OPTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const TEMPLATE_RE = /\{\{([^{}]*)\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{([^{}]*)\}\}$/;
const INPUT_REF_RE = /^inputs\.([a-z][a-z0-9_-]{0,31})$/;
const OUTPUT_REF_RE = /^steps\.([a-z][a-z0-9_-]{0,31})\.outputs\[(\d{1,2})\]$/;

export const INPUT_TYPES = ["string", "integer", "number", "boolean", "url"] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export type InputValue = string | number | boolean;

export interface WorkflowInput {
  type: InputType;
  description?: string;
  required?: boolean;
  default?: InputValue;
  /** string and url: most characters (MAX_VALUE_CHARS when absent). */
  max_length?: number;
  /** integer and number: inclusive bounds. */
  min?: number;
  max?: number;
  /** string, integer and number: the allowed values. */
  enum?: (string | number)[];
}

export interface WorkflowStep {
  id: string;
  /** Command path from the CLI catalog, e.g. `elevenlabs tts`. */
  command: string;
  args?: string[];
  options?: Record<string, RunOptionValue>;
  inputs?: Record<string, string | string[]>;
}

export interface WorkflowManifest {
  version: 1;
  description?: string;
  inputs: Record<string, WorkflowInput>;
  steps: WorkflowStep[];
}

/** A manifest, run input or rendered step that is not valid; the message is safe to show. */
export class WorkflowManifestError extends ValidationError {}

/** Output URLs of finished steps, by step id (null: the output has no URL). */
export type StepOutputs = Record<string, (string | null)[]>;

const defaultIndex = new CatalogIndex();

function fail(message: string): never {
  throw new WorkflowManifestError(message);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  if (extra !== undefined) fail(`${where}: unknown field "${extra.slice(0, 40)}"`);
}

/** A template reference: an input name or a step output. */
type Ref = { input: string } | { step: string; index: number };

function parseRef(raw: string, where: string): Ref {
  const ref = raw.trim();
  const input = INPUT_REF_RE.exec(ref);
  if (input) return { input: input[1] as string };
  const output = OUTPUT_REF_RE.exec(ref);
  if (output) {
    const index = Number(output[2]);
    if (index > MAX_OUTPUT_INDEX) fail(`${where}: output index above ${MAX_OUTPUT_INDEX}`);
    return { step: output[1] as string, index };
  }
  return fail(
    `${where}: "{{${ref.slice(0, 60)}}}" is not {{inputs.<name>}} or {{steps.<id>.outputs[<n>]}}`,
  );
}

function checkValueText(
  text: string,
  where: string,
  inputs: Record<string, WorkflowInput>,
  earlier: ReadonlySet<string>,
): void {
  if (text.length > MAX_VALUE_CHARS) fail(`${where}: longer than ${MAX_VALUE_CHARS} characters`);
  for (const match of text.matchAll(TEMPLATE_RE)) {
    const ref = parseRef(match[1] as string, where);
    if ("input" in ref && !(ref.input in inputs)) {
      fail(`${where}: input "${ref.input}" is not declared`);
    }
    if ("step" in ref && !earlier.has(ref.step)) {
      fail(`${where}: step "${ref.step}" is not an earlier step`);
    }
  }
}

function checkTyped(value: unknown, input: WorkflowInput, where: string): InputValue {
  switch (input.type) {
    case "string":
    case "url": {
      if (typeof value !== "string") fail(`${where} must be a string`);
      const max = input.max_length ?? MAX_VALUE_CHARS;
      if (value.length > max) fail(`${where} must be at most ${max} characters`);
      if (input.type === "url") assertPublicHttpsUrl(value, where);
      break;
    }
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        fail(`${where} must be an integer`);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where} must be a number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") fail(`${where} must be true or false`);
      break;
  }
  const typed = value as InputValue;
  if (typeof typed === "number") {
    if (input.min !== undefined && typed < input.min)
      fail(`${where} must be at least ${input.min}`);
    if (input.max !== undefined && typed > input.max) fail(`${where} must be at most ${input.max}`);
  }
  if (input.enum && !input.enum.includes(typed as string | number)) {
    fail(`${where} must be one of: ${input.enum.join(", ").slice(0, 300)}`);
  }
  return typed;
}

function parseInput(name: string, raw: unknown): WorkflowInput {
  const where = `inputs.${name}`;
  if (!ID_RE.test(name)) fail(`${where.slice(0, 60)}: input names are lowercase ids`);
  if (!isObject(raw)) fail(`${where} must be an object`);
  onlyKeys(
    raw,
    ["type", "description", "required", "default", "max_length", "min", "max", "enum"],
    where,
  );
  const type = raw.type;
  if (!INPUT_TYPES.includes(type as InputType)) {
    fail(`${where}.type must be one of ${INPUT_TYPES.join(", ")}`);
  }
  const input: WorkflowInput = { type: type as InputType };
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION) {
      fail(`${where}.description must be a string of at most ${MAX_DESCRIPTION} characters`);
    }
    input.description = raw.description;
  }
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") fail(`${where}.required must be true or false`);
    input.required = raw.required;
  }
  const textual = input.type === "string" || input.type === "url";
  const numeric = input.type === "integer" || input.type === "number";
  if (raw.max_length !== undefined) {
    const n = raw.max_length;
    if (!textual || typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_VALUE_CHARS) {
      fail(`${where}.max_length must be 1 to ${MAX_VALUE_CHARS} on a string or url input`);
    }
    input.max_length = n;
  }
  for (const bound of ["min", "max"] as const) {
    const n = raw[bound];
    if (n === undefined) continue;
    if (!numeric || typeof n !== "number" || !Number.isFinite(n)) {
      fail(`${where}.${bound} must be a number on an integer or number input`);
    }
    input[bound] = n;
  }
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    fail(`${where}: min is above max`);
  }
  if (raw.enum !== undefined) {
    const values = raw.enum;
    if (
      input.type === "boolean" ||
      input.type === "url" ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_ENUM
    ) {
      fail(`${where}.enum must list 1 to ${MAX_ENUM} values of a string or number input`);
    }
    input.enum = [];
    for (const [i, value] of values.entries()) {
      input.enum.push(checkTyped(value, { type: input.type }, `${where}.enum[${i}]`) as string);
    }
  }
  if (raw.default !== undefined) {
    input.default = checkTyped(raw.default, input, `${where}.default`);
  }
  return input;
}

function parseStep(
  raw: unknown,
  i: number,
  inputs: Record<string, WorkflowInput>,
  earlier: Set<string>,
  index: CatalogIndex,
): WorkflowStep {
  const where = `steps[${i}]`;
  if (!isObject(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, ["id", "command", "args", "options", "inputs"], where);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    fail(`${where}.id must be a lowercase id (a-z, 0-9, _ and -, at most 32 characters)`);
  }
  const id = raw.id;
  if (earlier.has(id)) fail(`${where}: step id "${id}" is used twice`);
  if (typeof raw.command !== "string" || raw.command.length > 100) {
    fail(`${where}.command must be a command path such as "elevenlabs tts"`);
  }
  const command = normaliseCommand(raw.command);
  if (!index.isRunnable(command)) {
    fail(`${where}.command "${command.slice(0, 100)}" is not a command this server runs`);
  }
  const step: WorkflowStep = { id, command };
  const text = (value: unknown, at: string): string => {
    if (typeof value !== "string") fail(`${at} must be a string`);
    checkValueText(value, at, inputs, earlier);
    return value;
  };
  const list = (value: unknown, at: string, max: number): string[] => {
    if (!Array.isArray(value) || value.length > max) {
      fail(`${at} must be an array of at most ${max} strings`);
    }
    return value.map((v, n) => text(v, `${at}[${n}]`));
  };
  if (raw.args !== undefined) step.args = list(raw.args, `${where}.args`, MAX_ARGS);
  if (raw.options !== undefined) {
    if (!isObject(raw.options) || Object.keys(raw.options).length > MAX_OPTIONS) {
      fail(`${where}.options must be an object of at most ${MAX_OPTIONS} options`);
    }
    step.options = {};
    for (const [name, value] of Object.entries(raw.options)) {
      const at = `${where}.options.${name.slice(0, 64)}`;
      if (!OPTION_NAME_RE.test(name)) fail(`${at}: not a valid option name`);
      if (typeof value === "number" || typeof value === "boolean") {
        if (typeof value === "number" && !Number.isFinite(value)) fail(`${at} must be finite`);
        step.options[name] = value;
      } else if (Array.isArray(value)) {
        step.options[name] = list(value, at, MAX_LIST);
      } else {
        step.options[name] = text(value, at);
      }
    }
  }
  if (raw.inputs !== undefined) {
    if (!isObject(raw.inputs) || Object.keys(raw.inputs).length > MAX_OPTIONS) {
      fail(`${where}.inputs must be an object of at most ${MAX_OPTIONS} entries`);
    }
    step.inputs = {};
    for (const [name, value] of Object.entries(raw.inputs)) {
      const at = `${where}.inputs.${name.slice(0, 64)}`;
      if (!OPTION_NAME_RE.test(name)) fail(`${at}: not a valid option name`);
      step.inputs[name] = Array.isArray(value) ? list(value, at, MAX_INPUT_FILES) : text(value, at);
    }
  }
  earlier.add(id);
  return step;
}

/**
 * Parse and validate a manifest. Commands must be ones this server runs;
 * option names and values are checked against the catalog again when each
 * step is rendered (prepareRun), with the run's real values.
 */
export function parseWorkflowManifest(
  text: string,
  index: CatalogIndex = defaultIndex,
): WorkflowManifest {
  if (new TextEncoder().encode(text).length > MAX_WORKFLOW_BYTES) {
    fail(`${WORKFLOW_FILE} must be at most ${MAX_WORKFLOW_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(`${WORKFLOW_FILE} is not valid JSON`);
  }
  if (!isObject(raw)) fail(`${WORKFLOW_FILE} must be a JSON object`);
  onlyKeys(raw, ["version", "description", "inputs", "steps"], WORKFLOW_FILE);
  if (raw.version !== 1) fail(`${WORKFLOW_FILE}: version must be 1`);
  if (
    raw.description !== undefined &&
    (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION)
  ) {
    fail(`description must be a string of at most ${MAX_DESCRIPTION} characters`);
  }
  const rawInputs = raw.inputs ?? {};
  if (!isObject(rawInputs) || Object.keys(rawInputs).length > MAX_WORKFLOW_INPUTS) {
    fail(`inputs must be an object of at most ${MAX_WORKFLOW_INPUTS} inputs`);
  }
  const inputs: Record<string, WorkflowInput> = {};
  for (const [name, value] of Object.entries(rawInputs)) inputs[name] = parseInput(name, value);
  if (
    !Array.isArray(raw.steps) ||
    raw.steps.length === 0 ||
    raw.steps.length > MAX_WORKFLOW_STEPS
  ) {
    fail(`steps must be an array of 1 to ${MAX_WORKFLOW_STEPS} steps`);
  }
  const earlier = new Set<string>();
  const steps = raw.steps.map((step, i) => parseStep(step, i, inputs, earlier, index));
  return {
    version: 1,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    inputs,
    steps,
  };
}

/**
 * Check a run's inputs against the manifest: no unknown names, every
 * required input present, types and bounds. Defaults fill absent inputs.
 */
export function validateRunInputs(
  manifest: WorkflowManifest,
  given: Record<string, unknown> = {},
): Record<string, InputValue> {
  const unknown = Object.keys(given).find((name) => !(name in manifest.inputs));
  if (unknown !== undefined) fail(`unknown input "${unknown.slice(0, 40)}"`);
  const values: Record<string, InputValue> = {};
  for (const [name, input] of Object.entries(manifest.inputs)) {
    const value = given[name];
    if (value === undefined || value === null) {
      if (input.default !== undefined) values[name] = input.default;
      else if (input.required) fail(`input "${name}" is required`);
      continue;
    }
    values[name] = checkTyped(value, input, `input "${name}"`);
  }
  return values;
}

/**
 * Render one step into a multix_run request. A value that is exactly one
 * template takes the referenced value as is (a number stays a number); an
 * absent optional input leaves that value out; templates inside longer text
 * are replaced by their text.
 */
export function renderStep(
  step: WorkflowStep,
  inputs: Record<string, InputValue>,
  outputs: StepOutputs,
): RunRequest {
  const resolve = (raw: string, where: string): InputValue | undefined => {
    const ref = parseRef(raw, where);
    if ("input" in ref) return inputs[ref.input];
    const urls = outputs[ref.step];
    if (!urls) fail(`${where}: step "${ref.step}" has not finished`);
    if (ref.index >= urls.length) {
      fail(`${where}: step "${ref.step}" produced ${urls.length} output(s), not ${ref.index + 1}`);
    }
    const url = urls[ref.index];
    if (!url) {
      fail(
        `${where}: output ${ref.index} of step "${ref.step}" has no URL (configure R2 storage in /dashboard)`,
      );
    }
    return url;
  };
  const value = (raw: string, where: string): InputValue | undefined => {
    const whole = WHOLE_TEMPLATE_RE.exec(raw);
    if (whole) return resolve(whole[1] as string, where);
    const text = raw.replace(TEMPLATE_RE, (_, ref: string) => String(resolve(ref, where) ?? ""));
    if (text.length > MAX_VALUE_CHARS) fail(`${where}: longer than ${MAX_VALUE_CHARS} characters`);
    return text;
  };
  const strings = (list: readonly string[], where: string): string[] =>
    list.flatMap((raw, i) => {
      const v = value(raw, `${where}[${i}]`);
      return v === undefined ? [] : [String(v)];
    });

  const request: RunRequest = { command: step.command };
  if (step.args) request.args = strings(step.args, `${step.id}.args`);
  if (step.options) {
    const options: Record<string, RunOptionValue> = {};
    for (const [name, raw] of Object.entries(step.options)) {
      const where = `${step.id}.options.${name}`;
      if (typeof raw === "string") {
        const v = value(raw, where);
        if (v !== undefined) options[name] = v;
      } else if (Array.isArray(raw)) {
        options[name] = strings(raw, where);
      } else {
        options[name] = raw;
      }
    }
    request.options = options;
  }
  if (step.inputs) {
    const files: Record<string, string | string[]> = {};
    for (const [name, raw] of Object.entries(step.inputs)) {
      const where = `${step.id}.inputs.${name}`;
      if (Array.isArray(raw)) {
        files[name] = strings(raw, where);
      } else {
        const v = value(raw, where);
        if (v !== undefined) files[name] = String(v);
      }
    }
    request.inputs = files;
  }
  return request;
}
