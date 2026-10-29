import { describe, expect, it } from "vitest";
import { buildCliCatalog } from "../scripts/cli-catalog-builder.js";
import { CLI_CATALOG, CatalogIndex, isRepeatable, optionName } from "../src/jobs/cli-catalog.js";
import {
  COMMAND_POLICIES,
  EXCLUDED_COMMANDS,
  GROUP_KEYS,
  OUTPUT_DIR_OPTION,
  OUTPUT_FILE_OPTION,
  policyFor,
} from "../src/jobs/cli-command-policy.js";
import { PROVIDER_SECRET_NAMES } from "../src/provider-secret-names.js";
import { loadCliProgram } from "./cli-program.js";

describe("CLI catalog", () => {
  it("matches the CLI's current commands (run `npm run catalog` in worker/ when this fails)", async () => {
    const program = await loadCliProgram();
    expect(CLI_CATALOG).toEqual(buildCliCatalog(program));
  }, 120_000);

  it("has a policy that only names commands, options and positionals the CLI has", () => {
    const index = new CatalogIndex();
    for (const [path, policy] of Object.entries(COMMAND_POLICIES)) {
      const entry = index.find(path);
      expect(entry, path).toBeDefined();
      const options = new Set(entry?.command.options.map(optionName));
      const positionals = new Set(entry?.command.positionals.map((p) => p.name));
      const named = [
        ...Object.keys(policy.fileOptions ?? {}),
        ...(policy.urlOptions ?? []),
        ...Object.keys(policy.forced ?? {}),
        ...(policy.unsupported ?? []),
        ...(policy.nameOptions ?? []),
        ...(policy.inlineFlagOptions ?? []),
        ...(policy.repeatable ?? []),
        ...(policy.caps?.count ?? []),
        ...(policy.caps?.duration ?? []),
        ...(policy.caps?.resolution ?? []),
      ];
      for (const name of named) expect(options.has(name), `${path} --${name}`).toBe(true);
      for (const name of policy.filePositionals ?? []) {
        expect(positionals.has(name), `${path} <${name}>`).toBe(true);
      }
      for (const name of policy.assetRefOptions ?? []) {
        expect(options.has(name) || positionals.has(name), `${path} ${name}`).toBe(true);
      }
    }
    for (const path of EXCLUDED_COMMANDS) expect(index.find(path), path).toBeDefined();
  });

  it("lists the offline `runway models` command with its --json flag", () => {
    const entry = new CatalogIndex().find("runway models");
    expect(entry?.group).toBe("runway");
    expect(entry?.command.options.map(optionName)).toContain("json");
  });

  it("maps provider groups to stored key names only", () => {
    const groups = new Set(CLI_CATALOG.groups.map((g) => g.group));
    for (const [group, names] of Object.entries(GROUP_KEYS)) {
      expect(groups.has(group), group).toBe(true);
      for (const name of names) expect(PROVIDER_SECRET_NAMES).toContain(name);
    }
  });

  it("covers every option that may name a local path or a file name", () => {
    // Any value option whose placeholder or description talks about files,
    // paths, directories or file names must be a file input, the server-owned
    // output, a checked file-name part, or unsupported. Exceptions are listed
    // by placeholder, with the reason.
    const fileish = /\b(?:file|files|path|paths|dir|directory|folder|filename|prefix|local)\b/i;
    const notPaths = new Set([
      "<json>", // inline JSON; a leading @ (read a file) is rejected for every value
      "<json|@file>", // same as <json>
      "<id>", // provider-side IDs (e.g. a HeyGen destination folder)
      "<fileId>", // a file already uploaded to the provider (TopView)
      "<str>", // plain text (e.g. align --text "... or pass --text-file")
      "<MB>", // a size
    ]);
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        if (EXCLUDED_COMMANDS.has(command.command)) continue;
        const policy = policyFor(command.command);
        for (const option of command.options) {
          if (!option.takesValue) continue;
          if (!fileish.test(option.flags) && !fileish.test(option.description)) continue;
          const name = optionName(option);
          const placeholder = /<[^>]+>/.exec(option.flags)?.[0] ?? "";
          const covered =
            name === OUTPUT_FILE_OPTION ||
            name === OUTPUT_DIR_OPTION ||
            policy.fileOptions?.[name] !== undefined ||
            policy.nameOptions?.includes(name) ||
            policy.unsupported?.includes(name) ||
            notPaths.has(placeholder);
          if (!covered) missing.push(`${command.command} ${option.flags}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("treats every option the CLI documents as repeatable as repeatable", () => {
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        const policy = policyFor(command.command);
        for (const option of command.options) {
          const documented = /\brepeatable\b(?!\s+output)|\brepeat --/i.test(option.description);
          if (
            documented &&
            !isRepeatable(option, policy) &&
            !policy.unsupported?.includes(optionName(option))
          ) {
            missing.push(`${command.command} ${option.flags}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
