/**
 * The generated CLI catalog (src/cli-catalog.json) with lookups by command
 * path and by option name. Regenerate the JSON with `npm run catalog`.
 */

import catalogJson from "../cli-catalog.json";
import type { CliCatalog, CliCommand, CliOption } from "./cli-catalog-types.js";
import { type CommandPolicy, EXCLUDED_COMMANDS } from "./cli-command-policy.js";

export const CLI_CATALOG: CliCatalog = catalogJson as CliCatalog;

export interface CatalogEntry {
  group: string;
  command: CliCommand;
}

export class CatalogIndex {
  private readonly byCommand = new Map<string, CatalogEntry>();

  constructor(readonly catalog: CliCatalog = CLI_CATALOG) {
    for (const group of catalog.groups) {
      for (const command of group.commands) {
        this.byCommand.set(command.command, { group: group.group, command });
      }
    }
  }

  /** The command entry, or undefined when the CLI has no such command. */
  find(path: string): CatalogEntry | undefined {
    return this.byCommand.get(path);
  }

  isRunnable(path: string): boolean {
    return this.byCommand.has(path) && !EXCLUDED_COMMANDS.has(path);
  }
}

/** Long option name without the leading dashes (`--num-images` -> `num-images`). */
export function optionName(option: CliOption): string {
  return option.long.replace(/^-+/, "");
}

/**
 * An option that may be given more than once: variadic, collected into an
 * array default, or listed as repeatable by the command's policy.
 */
export function isRepeatable(option: CliOption, policy: CommandPolicy = {}): boolean {
  return (
    option.variadic ||
    Array.isArray(option.default) ||
    (policy.repeatable?.includes(optionName(option)) ?? false)
  );
}

/** Split a command string into its path segments, collapsing whitespace. */
export function normaliseCommand(raw: string): string {
  return raw.trim().split(/\s+/).join(" ");
}
