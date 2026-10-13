import { describe, expect, it } from "vitest";
import { buildCliCatalog } from "../scripts/cli-catalog-builder.js";
import { CLI_CATALOG, CatalogIndex, optionName } from "../src/jobs/cli-catalog.js";
import { COMMAND_POLICIES, EXCLUDED_COMMANDS, GROUP_KEYS } from "../src/jobs/cli-command-policy.js";
import { PROVIDER_SECRET_NAMES } from "../src/provider-secret-names.js";
import { loadCliProgram } from "./cli-program.js";

describe("CLI catalog", () => {
  it("matches the CLI's current commands (run `npm run catalog` in worker/ when this fails)", async () => {
    const program = await loadCliProgram();
    expect(CLI_CATALOG).toEqual(buildCliCatalog(program));
  }, 30_000);

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

  it("maps provider groups to stored key names only", () => {
    const groups = new Set(CLI_CATALOG.groups.map((g) => g.group));
    for (const [group, names] of Object.entries(GROUP_KEYS)) {
      expect(groups.has(group), group).toBe(true);
      for (const name of names) expect(PROVIDER_SECRET_NAMES).toContain(name);
    }
  });

  it("marks every option whose placeholder names a local path as a file input or output", () => {
    const pathLike =
      /<(?:path|paths\.\.\.|file|files\.\.\.|pathOrUrl|path\|url(?:\.\.\.)?|ref|dir)>/;
    // `--model <ref>` is a model reference, not a file.
    const notFiles = new Set(["output", "output-dir", "model"]);
    const missing: string[] = [];
    for (const group of CLI_CATALOG.groups) {
      for (const command of group.commands) {
        if (EXCLUDED_COMMANDS.has(command.command)) continue;
        const policy = COMMAND_POLICIES[command.command] ?? {};
        for (const option of command.options) {
          const name = optionName(option);
          if (!pathLike.test(option.flags) || notFiles.has(name)) continue;
          const covered =
            policy.fileOptions?.[name] !== undefined || policy.unsupported?.includes(name);
          if (!covered) missing.push(`${command.command} --${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
