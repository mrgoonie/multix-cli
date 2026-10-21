/**
 * Local run ledger: one JSON line per command in ~/.multix/history.jsonl
 * (override with MULTIX_HISTORY_FILE, disable with MULTIX_HISTORY=0). It keeps
 * what is needed to measure and repeat work: argv (secret-looking option
 * values redacted), resolved model, outcome, error code, outputs with hashes,
 * provider usage (tokens, cost, credits, timings) and HTTP call counts. It
 * never stores env values or API keys. The file is rotated at 20 MB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageSummary } from "./run-state.js";

export interface HistoryEntry {
  v: 1;
  id: string;
  ts: string;
  duration_ms: number;
  cwd: string;
  version: string;
  command: string;
  provider: string;
  model?: string;
  argv: string[];
  ok: boolean;
  exit_code: number;
  dry_run?: boolean;
  error?: { code: string; message: string };
  outputs?: Array<{ path: string; bytes: number; sha256?: string; duration_s?: number }>;
  usage?: UsageSummary;
  http?: { requests: number; errors: number; ms: number };
  provider_ids?: string[];
}

const ROTATE_BYTES = 20 * 1024 * 1024;
const SECRET_OPTION = /^--?[\w-]*(key|token|secret|password|authorization)[\w-]*$/i;

export function historyEnabled(): boolean {
  const flag = process.env.MULTIX_HISTORY?.trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

export function historyFile(): string {
  return process.env.MULTIX_HISTORY_FILE
    ? path.resolve(process.env.MULTIX_HISTORY_FILE)
    : path.join(os.homedir(), ".multix", "history.jsonl");
}

/** Short, sortable, unique-enough id: h_<base36 ms><4 random>. */
export function newHistoryId(now = Date.now()): string {
  return `h_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** argv with values of secret-looking options replaced. */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (SECRET_OPTION.test(name)) {
      if (eq > 0) out.push(`${name}=[redacted]`);
      else {
        out.push(arg, "[redacted]");
        i++;
      }
    } else out.push(arg);
  }
  return out;
}

export function appendHistory(entry: HistoryEntry): void {
  if (!historyEnabled()) return;
  const file = historyFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // History is best effort; never fail the command because of it.
  }
}

/** All entries, oldest first (current file only). Malformed lines are skipped. */
export function readHistory(): HistoryEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(historyFile(), "utf8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {}
  }
  return entries;
}

/** Find by id, id prefix, or `last` / `last-N` (1 = most recent). */
export function findHistory(ref: string, entries = readHistory()): HistoryEntry | undefined {
  const last = ref.match(/^last(?:-(\d+))?$/);
  if (last) {
    const n = Number(last[1] ?? "1");
    return entries[entries.length - n];
  }
  return [...entries].reverse().find((e) => e.id === ref || e.id.startsWith(ref));
}

/** Parse "30m", "12h", "7d" into a cutoff timestamp (ms). */
export function parseSince(value: string, now = Date.now()): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!m) {
    const t = Date.parse(value);
    if (Number.isNaN(t))
      throw new Error(`Invalid --since: ${value}. Use 30m, 12h, 7d or an ISO date.`);
    return t;
  }
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2]?.toLowerCase() as "s"];
  return now - Number(m[1]) * unit;
}
