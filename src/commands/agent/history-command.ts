/**
 * `multix history` (list / show / stats) and `multix rerun`: read the local
 * run ledger written by the agent runtime, to review past runs, measure cost,
 * tokens and duration per provider or model, and repeat a run exactly.
 */

import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import {
  type HistoryEntry,
  findHistory,
  historyFile,
  parseSince,
  readHistory,
} from "../../agent/history-store.js";
import { run } from "../../agent/run-state.js";
import { ValidationError } from "../../core/errors.js";

interface ListOpts {
  last?: string;
  failed?: boolean;
  provider?: string;
  command?: string;
  since?: string;
}

function filterEntries(opts: ListOpts): HistoryEntry[] {
  const since = opts.since ? parseSince(opts.since) : undefined;
  return readHistory().filter(
    (e) =>
      (!opts.failed || !e.ok) &&
      (!opts.provider || e.provider === opts.provider) &&
      (!opts.command || e.command.includes(opts.command)) &&
      (since === undefined || Date.parse(e.ts) >= since),
  );
}

function money(n: number | undefined): string {
  return n === undefined ? "" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function brief(e: HistoryEntry): string {
  const status = e.ok ? (e.dry_run ? "dry" : "ok") : (e.error?.code ?? `exit ${e.exit_code}`);
  const usage = [
    money(e.usage?.cost_usd),
    e.usage?.credits !== undefined ? `${e.usage.credits} cr` : "",
    e.usage?.tokens?.total !== undefined ? `${e.usage.tokens.total} tok` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const outs = e.outputs?.length ? `${e.outputs.length} out` : "";
  return [
    e.id,
    e.ts.slice(5, 16).replace("T", " "),
    status.padEnd(14),
    `${(e.duration_ms / 1000).toFixed(1)}s`.padStart(7),
    e.command.padEnd(24),
    e.model ?? "",
    usage,
    outs,
  ]
    .filter(Boolean)
    .join("  ");
}

interface Bucket {
  key: string;
  runs: number;
  ok: number;
  duration_ms: number[];
  cost_usd?: number;
  credits?: number;
  tokens?: number;
  outputs: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export function historyStats(entries: HistoryEntry[], by: "provider" | "model" | "command") {
  const buckets = new Map<string, Bucket>();
  for (const e of entries) {
    if (e.dry_run) continue;
    const key = (by === "model" ? e.model : by === "command" ? e.command : e.provider) || "(none)";
    const b = buckets.get(key) ?? { key, runs: 0, ok: 0, duration_ms: [], outputs: 0 };
    b.runs++;
    if (e.ok) b.ok++;
    b.duration_ms.push(e.duration_ms);
    b.outputs += e.outputs?.length ?? 0;
    if (e.usage?.cost_usd !== undefined) b.cost_usd = (b.cost_usd ?? 0) + e.usage.cost_usd;
    if (e.usage?.credits !== undefined) b.credits = (b.credits ?? 0) + e.usage.credits;
    const tok =
      e.usage?.tokens?.total ?? (e.usage?.tokens?.input ?? 0) + (e.usage?.tokens?.output ?? 0);
    if (tok) b.tokens = (b.tokens ?? 0) + tok;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => b.runs - a.runs)
    .map((b) => ({
      [by]: b.key,
      runs: b.runs,
      success_rate: Math.round((b.ok / b.runs) * 1000) / 1000,
      p50_s: Math.round(percentile(b.duration_ms, 50) / 100) / 10,
      p90_s: Math.round(percentile(b.duration_ms, 90) / 100) / 10,
      outputs: b.outputs,
      ...(b.cost_usd !== undefined ? { cost_usd: Math.round(b.cost_usd * 1e4) / 1e4 } : {}),
      ...(b.credits !== undefined ? { credits: b.credits } : {}),
      ...(b.tokens !== undefined ? { tokens: b.tokens } : {}),
    }));
}

function addFilters(cmd: Command): Command {
  return cmd
    .option("--failed", "Only failed runs")
    .option("-p, --provider <group>", "Only this provider group")
    .option("-c, --command <text>", "Only commands containing this text")
    .option("--since <age>", "Only runs newer than 30m, 12h, 7d or an ISO date");
}

export function registerHistoryCommands(program: Command): void {
  const history = program
    .command("history")
    .description(
      "Review past runs: outcome, outputs, provider usage (tokens, cost, credits), duration. Ledger: ~/.multix/history.jsonl",
    );

  addFilters(
    history
      .command("list", { isDefault: true })
      .description("List recent runs, newest first")
      .option("-n, --last <n>", "How many runs", "20"),
  ).action((opts: ListOpts) => {
    const n = Number.parseInt(opts.last ?? "20", 10);
    const entries = filterEntries(opts).slice(-Math.max(1, n)).reverse();
    if (run.json) {
      console.log(JSON.stringify(entries));
      return;
    }
    if (entries.length === 0) {
      console.log(`No runs recorded yet (${historyFile()}).`);
      return;
    }
    for (const e of entries) console.log(brief(e));
    console.log("\nDetails: multix history show <id>   Repeat: multix rerun <id>");
  });

  history
    .command("show <ref>")
    .description("Show one run in full (id, id prefix, last or last-N)")
    .action((ref: string) => {
      const entry = findHistory(ref);
      if (!entry) throw new ValidationError(`No run matches ${ref}. List them: multix history`);
      console.log(JSON.stringify(entry, null, run.json ? 0 : 2));
    });

  addFilters(
    history
      .command("stats")
      .description("Aggregate runs: success rate, p50/p90 duration, cost, credits, tokens")
      .option("--by <field>", "Group by provider, model or command", "provider"),
  ).action((opts: ListOpts & { by?: string }) => {
    const by = opts.by ?? "provider";
    if (by !== "provider" && by !== "model" && by !== "command") {
      throw new ValidationError(`Invalid --by: ${by}. Valid: provider, model, command`);
    }
    const rows = historyStats(filterEntries(opts), by);
    if (run.json || rows.length === 0) {
      console.log(run.json ? JSON.stringify(rows) : "No runs recorded for these filters.");
      return;
    }
    for (const r of rows) {
      const { [by]: key, ...rest } = r as Record<string, unknown>;
      console.log(
        `${String(key).padEnd(28)} ${Object.entries(rest)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ")}`,
      );
    }
  });

  program
    .command("rerun <ref>")
    .description(
      "Run a recorded command again (id, id prefix, last or last-N); extra args are appended",
    )
    .argument("[extra...]", "Extra args appended after the recorded ones (later flags win)")
    .allowUnknownOption()
    .action((ref: string, extra: string[]) => {
      const entry = findHistory(ref);
      if (!entry) throw new ValidationError(`No run matches ${ref}. List them: multix history`);
      if (entry.argv.includes("[redacted]")) {
        throw new ValidationError(`Run ${entry.id} had a redacted secret option; run it by hand.`);
      }
      const script = process.argv[1] ?? "";
      const args = [...entry.argv, ...extra];
      if (run.json && !args.includes("--json")) args.push("--json");
      const res = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
      // The child prints its own envelope and history entry; this wrapper adds none.
      run.finalized = true;
      process.exitCode = res.status ?? 1;
    });
}
