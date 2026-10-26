/**
 * `multix_catalog` payloads: what a remote caller may run, shaped for an MCP
 * client. Without a group: every group with its commands (one line each).
 * With a group: full positionals and options of each runnable command, with
 * the server's treatment (file inputs, forced values, caps) marked.
 * With a task: only the commands and verified models that serve it. With a
 * model: that model's verified inputs, voices and formats.
 * Tasks and models come from the CLI's capability registry (src/capabilities),
 * the same source `multix models` reads.
 * Reports only whether the caller saved keys for a group, never key values.
 */

import {
  CAPABILITY_SCHEMA,
  type ModelCapability,
  TASKS,
  type Task,
  isTask,
} from "../../../src/capabilities/capability-types.js";
import { commandCapability } from "../../../src/capabilities/command-capabilities.js";
import { findModelCapability, verifiedModels } from "../../../src/capabilities/model-registry.js";
import { ValidationError } from "../../../src/core/errors.js";
import { findSpeechModel } from "../../../src/providers/fal/speech-models.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import type { CliCommand, CliGroup } from "./cli-catalog-types.js";
import { CLI_CATALOG, isRepeatable, optionName } from "./cli-catalog.js";
import {
  EXCLUDED_COMMANDS,
  GLOBALLY_UNSUPPORTED_OPTIONS,
  GROUP_KEYS,
  GROUP_REQUIRED_KEYS,
  OUTPUT_DIR_OPTION,
  OUTPUT_FILE_OPTION,
  policyFor,
} from "./cli-command-policy.js";

/** Whether the caller saved the keys a group needs (groups that need none are always ready). */
export function hasGroupKeys(group: string, keys: ProviderKeys): boolean {
  const names = GROUP_KEYS[group];
  if (!names || names.length === 0) return true;
  const rows = GROUP_REQUIRED_KEYS[group] ?? [[names[0]]];
  return rows.every((row) => row.some((name) => Boolean(name && keys[name]?.trim())));
}

function runnable(group: CliGroup): CliCommand[] {
  return group.commands.filter((c) => !EXCLUDED_COMMANDS.has(c.command));
}

function commandDetail(command: CliCommand): Record<string, unknown> {
  const policy = policyFor(command.command);
  const unsupported = new Set([...GLOBALLY_UNSUPPORTED_OPTIONS, ...(policy.unsupported ?? [])]);
  const options = command.options
    .filter((o) => !unsupported.has(optionName(o)) && optionName(o) !== OUTPUT_DIR_OPTION)
    .map((option) => {
      const name = optionName(option);
      const view: Record<string, unknown> = {
        name,
        flags: option.flags,
        description: option.description,
        required: option.required,
        takes_value: option.takesValue,
        multiple: isRepeatable(option, policy),
      };
      if (option.default !== undefined) view.default = option.default;
      const input = policy.fileOptions?.[name];
      if (input) view.input = input === "dir" ? "files (directory)" : "file";
      if (policy.assetRefOptions?.includes(name)) view.accepts_asset_ref = true;
      if (policy.urlOptions?.includes(name)) view.https_url = true;
      if (policy.forced?.[name] !== undefined) view.forced = policy.forced[name];
      if (policy.nameOptions?.includes(name)) view.format = "letters, digits, _ and - only";
      if (name === OUTPUT_FILE_OPTION) view.output = "plain file name inside the job output";
      return view;
    });
  const positionals = command.positionals.map((p) => ({
    name: p.name,
    description: p.description,
    required: p.required,
    multiple: p.variadic,
    ...(policy.filePositionals?.includes(p.name) ? { input: "file" } : {}),
  }));
  const cap = commandCapability(command.command);
  return {
    command: command.command,
    description: command.description,
    ...(cap ? capabilityFields(command, cap.tasks) : {}),
    positionals,
    options,
  };
}

/** Tasks, outputs and model scope of a command, from the capability registry. */
function capabilityFields(command: CliCommand, tasks: readonly Task[]): Record<string, unknown> {
  const cap = commandCapability(command.command);
  if (!cap) return {};
  const model = command.options.find((o) => o.long === "--model" || o.long === "--model-id");
  return {
    tasks,
    ...(cap.outputs.length ? { outputs: cap.outputs } : {}),
    ...(typeof model?.default === "string" ? { default_model: model.default } : {}),
    ...(cap.models === "provider-catalog" ? { any_model: true, model_scope: cap.scope } : {}),
  };
}

/** Provider model ids: "elevenlabs/tts/eleven-v4", "fal-ai/flux/dev", "owner/model:version". */
export const MODEL_ID_RE = /^[\w.:@/-]{1,200}$/;

export interface CatalogFilter {
  task?: string;
  model?: string;
}

function parseTask(task: string): Task {
  if (!isTask(task)) {
    throw new ValidationError(`Unknown task "${task}"; one of ${TASKS.join(", ")}`);
  }
  return task;
}

/** Commands and verified models for one task, across groups (or inside one). */
function taskPayload(keys: ProviderKeys, groups: CliGroup[], task: Task): Record<string, unknown> {
  const commands = groups.flatMap((g) =>
    runnable(g)
      .filter((c) => commandCapability(c.command)?.tasks.includes(task))
      .map((c) => ({
        command: c.command,
        description: c.description,
        has_keys: hasGroupKeys(g.group, keys),
        ...capabilityFields(c, [task]),
      })),
  );
  const names = new Set(groups.map((g) => g.group));
  const runnablePaths = new Set(groups.flatMap((g) => runnable(g).map((c) => c.command)));
  const models = verifiedModels({ task })
    .filter((m) => names.has(m.provider) && runnablePaths.has(m.command))
    .map((m) => ({
      model: m.model,
      name: m.name,
      provider: m.provider,
      command: m.command,
      has_keys: hasGroupKeys(m.provider, keys),
    }));
  return {
    schema: CAPABILITY_SCHEMA,
    task,
    commands,
    models,
    next: "Call multix_catalog with a model for its inputs, or with a group for full options; then multix_run.",
  };
}

function modelPayload(
  keys: ProviderKeys,
  groups: CliGroup[],
  id: string,
  provider?: string,
): Record<string, unknown> {
  const cap = findModelCapability(id, provider);
  const command = groups.flatMap(runnable).find((c) => c.command === cap?.command);
  if (!cap || !command) {
    return {
      schema: CAPABILITY_SCHEMA,
      model: id,
      verified: null,
      note: "Not a verified model on this server; its inputs are unknown. Call multix_catalog with a task for verified models.",
    };
  }
  return {
    schema: CAPABILITY_SCHEMA,
    model: id,
    verified: cap,
    has_keys: hasGroupKeys(cap.provider, keys),
    usage:
      cap.command === "fal run"
        ? `multix_run: command "fal run", args ["${cap.model}"], options {"input": "<JSON of the inputs above>"}`
        : cap.command === "fal tts"
          ? falTtsUsage(cap)
          : `multix_run: command "${cap.command}", args [${command.positionals
              .map((p) => `"<${p.name}>"`)
              .join(", ")}], options {"model": "${cap.model}"}`,
  };
}

/**
 * `fal tts` has typed options (--voice, --style, --format, --language) that
 * set the model's own fields; every other endpoint field goes through --input
 * as JSON. Endpoint field names are not options: `fal tts` rejects them.
 */
function falTtsUsage(cap: ModelCapability): string {
  const profile = findSpeechModel(cap.model);
  const fields: Array<[option: string, field: string | undefined]> = [
    ["voice", profile?.voiceField],
    ["style", profile?.styleField],
    ["format", profile?.formatField],
    ["language", profile?.languageField],
  ];
  const typed = fields.flatMap(
    ([option, field]): Array<[string, string]> => (field ? [[option, field]] : []),
  );
  const covered = new Set<string>([profile?.textField ?? "", ...typed.map(([, field]) => field)]);
  const rest = Object.keys(cap.inputs).filter((field) => !covered.has(field));
  const options = [
    `"model": "${cap.model}"`,
    ...typed.map(([option, field]) => `"${option}": "<${field}>"`),
    ...(rest.length ? [`"input": "<JSON object with any of ${rest.join(", ")}>"`] : []),
  ];
  return `multix_run: command "fal tts", args ["<text>"], options {${options.join(", ")}}. Only these options are accepted; put other fields above in input.`;
}

export function catalogPayload(
  keys: ProviderKeys,
  group?: string,
  filter: CatalogFilter = {},
): Record<string, unknown> {
  const groups = CLI_CATALOG.groups.filter((g) => runnable(g).length > 0);
  if (filter.model !== undefined) return modelPayload(keys, groups, filter.model, group);
  if (filter.task !== undefined) {
    const task = parseTask(filter.task);
    const scope = group === undefined ? groups : groups.filter((g) => g.group === group);
    if (group !== undefined && scope.length === 0) {
      throw new ValidationError(`Unknown group "${group}"; call multix_catalog without a group`);
    }
    return taskPayload(keys, scope, task);
  }
  if (group === undefined) {
    return {
      groups: groups.map((g) => ({
        group: g.group,
        description: g.description,
        has_keys: hasGroupKeys(g.group, keys),
        commands: runnable(g).map((c) => ({ command: c.command, description: c.description })),
      })),
      next: "Call multix_catalog with a group for its options, then multix_run.",
    };
  }
  const match = groups.find((g) => g.group === group);
  if (!match)
    throw new ValidationError(`Unknown group "${group}"; call multix_catalog without a group`);
  return {
    group: match.group,
    description: match.description,
    has_keys: hasGroupKeys(match.group, keys),
    commands: runnable(match).map(commandDetail),
    usage:
      "multix_run: options by long name without dashes; positionals in args; files as https URLs in inputs (keyed by option or positional name). Output files are uploaded to your R2 bucket.",
  };
}
