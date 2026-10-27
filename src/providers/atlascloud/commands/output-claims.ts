/**
 * Local file names for Atlas Cloud outputs: finding an output an earlier run
 * already saved, picking a free name, and reserving a name while it downloads.
 *
 * A name is reserved by the lock file `<dest>.part`, created exclusively and
 * holding `{ pid, host, startedAt }`. A lock whose process is gone (Ctrl+C, a
 * killed shell, a crash) is stale and is taken over by the next run, which
 * also deletes that run's orphaned download temp files. On SIGINT/SIGTERM/SIGHUP the
 * current run removes its own locks and temp files before exiting.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderError } from "../../../core/errors.js";
import { downloadToFile } from "../../../core/http-client.js";
import type { UrlValidator } from "../../../core/url-safety.js";
import { ATLAS_PROVIDER } from "../models.js";

/**
 * How a planned output name treats a file that is already there:
 * - `overwrite`: a single-output `--output` file the user chose;
 * - `reuse`: a generated `atlas-<id>-NN` name (no `--output`, or a directory).
 *   It is deterministic per prediction output, so an existing file is that
 *   output, saved by an earlier run, and is kept instead of downloaded again;
 * - `unique`: the `<base>-NN` names derived from a multi-output `--output` file
 *   can match unrelated files, so a free `-N` suffix is picked instead.
 */
export type NamingPolicy = "overwrite" | "reuse" | "unique";

const PART = ".part";
// The lock `<dest>.part`, or downloadToFile's in-flight `<dest>.<pid>-<time>-<rand>.part`.
const PART_SUFFIX = /(?:\.\d+-\d+-[a-z0-9]+)?\.part$/i;
// What follows `<dest>` in a downloadToFile temp file name.
const TEMP_TAIL = /^\.(\d+)-\d+-[a-z0-9]+\.part$/i;
const MAX_UNIQUE_ATTEMPTS = 1000;
// A lock is written right after its exclusive create; give a writer this long
// before an unreadable lock counts as stale.
const UNREADABLE_LOCK_GRACE_MS = 10_000;
// Windows and default macOS file systems ignore case, so names must too.
const foldCase = process.platform === "win32" || process.platform === "darwin";
const fold = (s: string) => (foldCase ? s.toLowerCase() : s);

/** Name without extension (and without a `.part` suffix), case-folded where the file system is. */
function stemOf(name: string): string {
  const base = name.replace(PART_SUFFIX, "");
  return fold(base.slice(0, base.length - path.extname(base).length));
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return []; // the directory does not exist yet: nothing to collide with
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort, e.g. EBUSY while another handle is still open on Windows
  }
}

/**
 * A complete output beside `file` with the same stem, whatever its extension
 * (a PNG may have become WebP), or undefined. Only a regular, non-empty file
 * counts: never a `.part` file, a directory or an empty file. The exact
 * planned name wins when several match.
 */
export function savedOutput(file: string): string | undefined {
  const dir = path.dirname(file);
  const stem = stemOf(path.basename(file));
  const matches = listDir(dir).filter((n) => {
    if (PART_SUFFIX.test(n) || stemOf(n) !== stem) return false;
    const st = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
    return st?.isFile() === true && st.size > 0;
  });
  const exact = matches.find((n) => n === path.basename(file));
  const found = exact ?? matches.sort()[0];
  return found === undefined ? undefined : path.join(dir, found);
}

/**
 * `file`, or the first `<stem>-N<ext>` beside it whose stem no file in the
 * directory has, whatever its extension, including an in-progress `.part`
 * download, so neither a different output type nor a later WebP conversion
 * (`.png` -> `.webp`) can overwrite an earlier output.
 */
export function availableOutputPath(file: string): string {
  return candidateNames(file).next().value as string;
}

function* candidateNames(file: string): Generator<string> {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const taken = new Set(listDir(dir).map(stemOf));
  for (let n = 0; n < MAX_UNIQUE_ATTEMPTS; n++) {
    const name = n === 0 ? stem : `${stem}-${n}`;
    if (!taken.has(fold(name))) yield path.join(dir, `${name}${ext}`);
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

function readLock(lock: string): LockInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(lock, "utf8")) as Partial<LockInfo>;
    if (Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.host === "string") {
      return v as LockInfo;
    }
  } catch {
    // unreadable or not JSON
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A lock left by a run that is gone, or one that never got its content. */
function isStaleLock(lock: string): boolean {
  const info = readLock(lock);
  if (!info) {
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    return st === undefined || Date.now() - st.mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  }
  // A process id means nothing on another machine (e.g. a shared network folder).
  if (info.host !== os.hostname()) return false;
  return !isProcessAlive(info.pid);
}

/** Dests this run holds a lock for, so an interrupt can clean them up. */
const activeClaims = new Set<string>();

/** Create `<dest>.part` exclusively, taking over a stale one; false when a live run holds it. */
function tryLock(dest: string): boolean {
  const lock = `${dest}${PART}`;
  const content = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  } satisfies LockInfo);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, content, { flag: "wx" });
      activeClaims.add(dest);
      installInterruptCleanup();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (attempt > 0 || !isStaleLock(lock)) return false;
      // Take over: remove, then create exclusively again. Two runs reclaiming
      // the same stale lock at the same instant are the only way both could
      // proceed, and they would write the same output.
      removeQuietly(lock);
    }
  }
  return false;
}

/** Delete download temp files for `dest` left by processes that no longer run. */
function removeOrphanedTemps(dest: string): void {
  const base = path.basename(dest);
  const dir = path.dirname(dest);
  for (const n of listDir(dir)) {
    if (!n.startsWith(base)) continue;
    const m = TEMP_TAIL.exec(n.slice(base.length));
    if (m?.[1] && !isProcessAlive(Number(m[1]))) removeQuietly(path.join(dir, n));
  }
}

/** Release a lock taken by claimOutputPath (no-op for one this run does not hold). */
export function releaseClaim(dest: string): void {
  if (!activeClaims.delete(dest)) return;
  removeQuietly(`${dest}${PART}`);
}

/** Remove this run's locks and its in-flight download temp files. */
export function cleanupActiveClaims(): void {
  for (const dest of [...activeClaims]) {
    const base = path.basename(dest);
    const dir = path.dirname(dest);
    for (const n of listDir(dir)) {
      if (!n.startsWith(base)) continue;
      const m = TEMP_TAIL.exec(n.slice(base.length));
      if (m?.[1] && Number(m[1]) === process.pid) removeQuietly(path.join(dir, n));
    }
    releaseClaim(dest);
  }
}

const INTERRUPT_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/** Clean up, then exit with the conventional 128+signal code. */
export function handleInterrupt(
  signal: keyof typeof INTERRUPT_EXIT_CODES,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  cleanupActiveClaims();
  exit(INTERRUPT_EXIT_CODES[signal]);
}

let interruptCleanupInstalled = false;

function installInterruptCleanup(): void {
  if (interruptCleanupInstalled) return;
  interruptCleanupInstalled = true;
  for (const signal of Object.keys(INTERRUPT_EXIT_CODES) as Array<
    keyof typeof INTERRUPT_EXIT_CODES
  >) {
    process.once(signal, () => handleInterrupt(signal));
  }
}

function heldMessage(dest: string): string {
  const info = readLock(`${dest}${PART}`);
  const holder = info ? ` (pid ${info.pid} on ${info.host})` : "";
  const advice =
    "Wait for it to finish, then retry. A lock left by a run that has stopped is replaced automatically.";
  return `${dest}${PART} is held by another multix run${holder} downloading this output. ${advice}`;
}

/**
 * Pick the destination for `file` under `policy` and, unless it is a file the
 * user asked to overwrite, reserve it with the `<dest>.part` lock, so two
 * concurrent runs can never write one name. Orphaned temp files for the name
 * are removed once it is held. Release with `releaseClaim`.
 */
export function claimOutputPath(file: string, policy: NamingPolicy): string {
  if (policy === "overwrite") return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (policy === "reuse") {
    if (!tryLock(file)) throw new ProviderError(heldMessage(file), ATLAS_PROVIDER);
    removeOrphanedTemps(file);
    return file;
  }
  for (const candidate of candidateNames(file)) {
    if (!tryLock(candidate)) continue;
    // The listing can disagree with how the file system compares names
    // (case-insensitive mounts on Linux, Unicode normalization), so ask the
    // file system itself while holding the lock.
    if (fs.existsSync(candidate)) {
      releaseClaim(candidate);
      continue;
    }
    removeOrphanedTemps(candidate);
    return candidate;
  }
  throw new ProviderError(
    `No free file name for ${file} after ${MAX_UNIQUE_ATTEMPTS} attempts; choose another --output.`,
    ATLAS_PROVIDER,
  );
}

/**
 * Download `url` to the name `choose` picks from the response, claimed under
 * `policy`. downloadToFile streams into its own temporary `.part` and renames
 * it into place only when complete (removing it on failure), so a failed
 * download never deletes or truncates a file the user already had. The lock
 * is released either way, so no `.part` file is left behind.
 *
 * A `reuse` claim does not re-check for a saved file once the headers arrive:
 * a concurrent run that finished in between wrote the very same output, so
 * downloading it again only costs bandwidth and replaces identical bytes.
 */
export async function downloadClaimed(
  url: string,
  choose: (response: Response) => string,
  policy: NamingPolicy,
  opts: { maxBytes: number; validateUrl?: UrlValidator },
): Promise<string> {
  let claimed: string | undefined;
  try {
    const { dest } = await downloadToFile(url, {
      ...opts,
      dest: (response) => {
        const dest = claimOutputPath(choose(response), policy);
        if (policy !== "overwrite") claimed = dest;
        return dest;
      },
    });
    return dest;
  } finally {
    if (claimed) releaseClaim(claimed);
  }
}
