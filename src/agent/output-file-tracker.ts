/**
 * Learns which files a command produced without touching the 100+ command
 * implementations: wraps the node:fs write entry points for this CLI process
 * (writeFile*, createWriteStream, copyFile*, rename*) and re-syncs the ESM
 * named exports so `import { writeFileSync } from "node:fs"` sees the wrapper
 * too. Only the path is recorded; the write itself is unchanged.
 */

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveOutputDir } from "../core/output-dir.js";
import { run } from "./run-state.js";

function track(target: unknown): void {
  if (typeof target === "string") run.written.add(path.resolve(target));
  else if (target instanceof URL && target.protocol === "file:") run.written.add(target.pathname);
}

function untrack(target: unknown): void {
  if (typeof target === "string") run.written.delete(path.resolve(target));
}

// biome-ignore lint/suspicious/noExplicitAny: wraps arbitrary fs signatures
type AnyFn = (...args: any[]) => any;

function wrap(obj: object, name: string, before: (args: unknown[]) => void): void {
  const record = obj as Record<string, AnyFn>;
  const original = record[name];
  if (typeof original !== "function") return;
  record[name] = function wrapped(this: unknown, ...args: unknown[]) {
    try {
      before(args);
    } catch {}
    return original.apply(this, args);
  };
}

export function installOutputFileTracker(): void {
  for (const name of ["writeFileSync", "writeFile", "createWriteStream"]) {
    wrap(fs, name, (args) => track(args[0]));
  }
  for (const name of ["copyFileSync", "copyFile"]) wrap(fs, name, (args) => track(args[1]));
  for (const name of ["renameSync", "rename"]) {
    wrap(fs, name, (args) => {
      untrack(args[0]);
      track(args[1]);
    });
  }
  wrap(fs.promises, "writeFile", (args) => track(args[0]));
  wrap(fs.promises, "copyFile", (args) => track(args[1]));
  wrap(fs.promises, "rename", (args) => {
    untrack(args[0]);
    track(args[1]);
  });
  syncBuiltinESMExports();
}

function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isWithin(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Files this run produced that still exist, excluding ~/.multix state and the
 * CLI's own temp files. A file under the temp dir counts only when it was
 * asked for: the explicit output path, or inside an output directory
 * (MULTIX_OUTPUT_DIR or `outputDirs`) that itself lives in the temp dir. An
 * output directory that is the temp root counts only files directly in it, and
 * one that contains the temp dir counts none of it, so scratch subdirectories
 * stay excluded.
 */
export function producedFiles(extra: string[] = [], outputDirs: string[] = []): string[] {
  const tmp = fs.realpathSync(os.tmpdir());
  const state = path.join(os.homedir(), ".multix");
  const extras = new Set(extra.map((p) => path.resolve(p)));
  const roots = [resolveOutputDir(), ...outputDirs].map(realDir);
  const requested = (dir: string) =>
    roots.some((root) => (isWithin(tmp, root) ? root === tmp && dir === tmp : isWithin(dir, root)));
  const all = new Set([...run.written, ...extras]);
  return [...all].filter((file) => {
    if (file.startsWith(state) || /\.tmp-\d+|\.part$|\.tmp$/.test(file)) return false;
    try {
      const dir = fs.realpathSync(path.dirname(file));
      if (isWithin(dir, tmp) && !extras.has(file) && !requested(dir)) return false;
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
