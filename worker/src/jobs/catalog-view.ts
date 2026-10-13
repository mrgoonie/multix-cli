/**
 * `multix_catalog` payloads: what a remote caller may run, shaped for an MCP
 * client. Without a group: every group with its commands (one line each).
 * With a group: full positionals and options of each runnable command, with
 * the server's treatment (file inputs, forced values, caps) marked.
 * Reports only whether the caller saved keys for a group, never key values.
 */

import { ValidationError } from "../../../src/core/errors.js";
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
        multiple: isRepeatable(option),
      };
      if (option.default !== undefined) view.default = option.default;
      const input = policy.fileOptions?.[name];
      if (input) view.input = input === "dir" ? "files (directory)" : "file";
      if (policy.assetRefOptions?.includes(name)) view.accepts_asset_ref = true;
      if (policy.urlOptions?.includes(name)) view.https_url = true;
      if (policy.forced?.[name] !== undefined) view.forced = policy.forced[name];
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
  return { command: command.command, description: command.description, positionals, options };
}

export function catalogPayload(keys: ProviderKeys, group?: string): Record<string, unknown> {
  const groups = CLI_CATALOG.groups.filter((g) => runnable(g).length > 0);
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
