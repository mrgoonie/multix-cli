/**
 * Turn the multix commander program into the plain-JSON catalog the Worker
 * ships (src/cli-catalog.json). Pure: takes an already-built program, so the
 * generator script (build-cli-catalog.ts) and the freshness test share it
 * without either side pulling commander into the Worker bundle.
 *
 * Only the structural parts of commander used here are typed, so this file
 * type-checks without commander's or Node's type definitions.
 */

import type {
  CliCatalog,
  CliCommand,
  CliGroup,
  CliOption,
  CliPositional,
} from "../src/jobs/cli-catalog-types.js";

interface ArgumentLike {
  name(): string;
  description: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: unknown;
}

interface OptionLike {
  flags: string;
  description: string;
  long?: string;
  short?: string;
  required: boolean;
  optional: boolean;
  mandatory: boolean;
  variadic: boolean;
  negate: boolean;
  hidden: boolean;
  defaultValue?: unknown;
}

export interface CommandLike {
  name(): string;
  description(): string;
  commands: readonly CommandLike[];
  options: readonly OptionLike[];
  registeredArguments: readonly ArgumentLike[];
}

/** JSON-safe default, or undefined when there is none worth showing. */
function jsonDefault(value: unknown): CliOption["default"] {
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return [...value];
  return undefined;
}

function optionEntry(option: OptionLike): CliOption {
  const entry: CliOption = {
    long: option.long ?? option.flags,
    flags: option.flags,
    description: option.description,
    required: option.mandatory,
    takesValue: option.required || option.optional,
    valueOptional: option.optional,
    variadic: option.variadic,
    negatable: option.negate,
  };
  if (option.short) entry.short = option.short;
  const fallback = jsonDefault(option.defaultValue);
  if (fallback !== undefined) entry.default = fallback;
  return entry;
}

function positionalEntry(argument: ArgumentLike): CliPositional {
  const entry: CliPositional = {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
  };
  const fallback = jsonDefault(argument.defaultValue);
  if (fallback !== undefined) entry.default = fallback;
  return entry;
}

/** Every runnable (leaf) command under `command`, with its full space-separated path. */
function leafCommands(command: CommandLike, path: string[]): CliCommand[] {
  if (command.commands.length > 0) {
    return command.commands.flatMap((sub) => leafCommands(sub, [...path, sub.name()]));
  }
  return [
    {
      command: path.join(" "),
      description: command.description(),
      positionals: command.registeredArguments.map(positionalEntry),
      options: command.options.filter((o) => !o.hidden).map(optionEntry),
    },
  ];
}

export function buildCliCatalog(program: CommandLike): CliCatalog {
  const groups: CliGroup[] = program.commands.map((top) => ({
    group: top.name(),
    description: top.description(),
    commands: leafCommands(top, [top.name()]),
  }));
  return { groups };
}
