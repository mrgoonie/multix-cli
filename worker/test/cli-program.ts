/**
 * Build the real multix commander program inside vitest, the same way
 * src/cli.ts does, without parsing process argv. Loaded at run time by file
 * path so neither commander nor the CLI's Node types reach the Worker
 * typecheck or bundle.
 */

import type { CommandLike } from "../scripts/cli-catalog-builder.js";

export interface ProgramCommand extends CommandLike {
  commands: readonly ProgramCommand[];
  action(fn: (...args: unknown[]) => void): ProgramCommand;
  exitOverride(): ProgramCommand;
  configureOutput(output: { writeOut(s: string): void; writeErr(s: string): void }): ProgramCommand;
  parseAsync(argv: string[], options?: { from: "user" }): Promise<ProgramCommand>;
  opts(): Record<string, unknown>;
}

const testFileUrl = (import.meta as unknown as { url: string }).url;
const fromRepo = (rel: string) => decodeURIComponent(new URL(`../../${rel}`, testFileUrl).pathname);

export async function loadCliProgram(): Promise<ProgramCommand> {
  const { Command } = (await import(
    /* @vite-ignore */ fromRepo("node_modules/commander/esm.mjs")
  )) as { Command: new () => ProgramCommand & { enablePositionalOptions(): ProgramCommand } };
  const { registerCommands } = (await import(
    /* @vite-ignore */ fromRepo("src/commands/index.ts")
  )) as { registerCommands(program: ProgramCommand): void };
  const program = new Command().enablePositionalOptions();
  registerCommands(program);
  return program;
}

export function findCommand(program: ProgramCommand, path: string): ProgramCommand {
  let current = program;
  for (const name of path.split(" ")) {
    const next = current.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`No command ${path}`);
    current = next;
  }
  return current;
}

/**
 * Parse argv with the real command definitions, replacing the leaf action so
 * nothing runs. Returns the parsed positionals and options.
 */
export async function parseWithCli(
  argv: string[],
  path: string,
): Promise<{ args: unknown[]; opts: Record<string, unknown> }> {
  const program = await loadCliProgram();
  const leaf = findCommand(program, path);
  let captured: { args: unknown[]; opts: Record<string, unknown> } | undefined;
  leaf.action((...received: unknown[]) => {
    // commander passes (...positionals, opts, command).
    captured = { args: received.slice(0, -2), opts: leaf.opts() };
  });
  for (const cmd of [program, leaf]) {
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  }
  await program.parseAsync(argv, { from: "user" });
  if (!captured) throw new Error("action did not run");
  return captured;
}
