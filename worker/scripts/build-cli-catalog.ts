#!/usr/bin/env node
/**
 * Regenerate src/cli-catalog.json from the CLI's own command definitions.
 * Usage (from worker/): npm run catalog
 *
 * Builds the program the same way src/cli.ts does (registerCommands on a
 * Command with positional options), without parsing argv or loading .env.
 * commander is resolved from the repository root, where the CLI depends on it.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CommandLike, buildCliCatalog } from "./cli-catalog-builder.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const output = fileURLToPath(new URL("../src/cli-catalog.json", import.meta.url));

const requireFromCli = createRequire(`${repoRoot}src/cli.ts`);
const { Command } = (await import(pathToFileURL(requireFromCli.resolve("commander")).href)) as {
  Command: new () => CommandLike & { enablePositionalOptions(): CommandLike };
};
const { registerCommands } = (await import(
  pathToFileURL(`${repoRoot}src/commands/index.ts`).href
)) as { registerCommands(program: CommandLike): void };

const program = new Command().enablePositionalOptions();
registerCommands(program);
const catalog = buildCliCatalog(program);

writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
// Match the repository's formatter so `npm run lint` stays clean.
execFileSync(`${repoRoot}node_modules/.bin/biome`, ["format", "--write", output], {
  stdio: "inherit",
});
const commands = catalog.groups.reduce((n, g) => n + g.commands.length, 0);
console.log(`cli-catalog: ${catalog.groups.length} groups, ${commands} commands -> ${output}`);
