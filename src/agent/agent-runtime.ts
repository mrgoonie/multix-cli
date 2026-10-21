/**
 * Agent runtime for the CLI process. Installed once by cli.ts, it gives every
 * command, without per-command code:
 * - `--json` (or MULTIX_OUTPUT=json): one `multix.result/v1` envelope on stdout,
 *   human output captured instead of printed;
 * - `--dry-run`: local validation runs, then the first network request is
 *   reported instead of sent (local `media` commands stop before running);
 * - classified errors with hint and next steps, and exit codes by class;
 * - a history entry with outputs, usage (tokens, cost, credits, timings).
 * Commands that call process.exit() directly are covered by wrapping it.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { type ErrorInfo, classifyError, classifyMessage } from "../core/error-classify.js";
import { type DryRunRequest, installFetchTelemetry } from "./fetch-telemetry.js";
import { appendHistory, newHistoryId, redactArgv } from "./history-store.js";
import { type OutputFile, type OutputWarning, inspectOutput } from "./output-file-inspect.js";
import { installOutputFileTracker, producedFiles } from "./output-file-tracker.js";
import {
  ENVELOPE_SCHEMA,
  type ResultEnvelope,
  nextForError,
  stdoutPayload,
  stripAnsi,
  suggestedCommands,
} from "./result-envelope.js";
import { run, summarizeUsage } from "./run-state.js";

/** Commands that are themselves agent tooling or setup: not recorded in history. */
const UNRECORDED = /^(history|models|guide|rerun|check|update)\b/;
/** Groups that run locally (ffmpeg/ImageMagick): dry run stops before the action. */
const LOCAL_GROUPS = new Set(["media"]);

let version = "0.0.0";
const realExit = process.exit.bind(process);
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);
/** Commands whose own --dry-run predates the global one (keep their meaning). */
const ownDryRun = new WeakSet<Command>();

function flagInArgv(argv: string[], flag: string): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes(flag);
}

function commandPath(cmd: Command): string[] {
  const names: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name());
  return names;
}

/** Top-level groups that call a provider (the rest are local or agent tooling). */
const NON_PROVIDER_GROUPS = new Set([
  "check",
  "update",
  "media",
  "models",
  "guide",
  "history",
  "rerun",
  "help",
]);

/**
 * Best-effort command path from argv, for errors commander raises before any
 * action hook runs (unknown option, missing argument): walks subcommand names.
 */
function commandFromArgv(program: Command, argv: string[]): string[] {
  const names: string[] = [];
  let cmd: Command = program;
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    const sub = cmd.commands.find((c) => c.name() === arg || c.aliases().includes(arg));
    if (!sub) break;
    names.push(sub.name());
    cmd = sub;
  }
  return names;
}

function setCommand(names: string[]): void {
  run.command = names.join(" ");
  run.group = names[0] && !NON_PROVIDER_GROUPS.has(names[0]) ? names[0] : "";
}

/** Add --json and --dry-run to every command that lacks them. */
function addGlobalFlags(cmd: Command): void {
  const has = (flag: string) => cmd.options.some((o) => o.long === flag);
  if (!has("--json")) cmd.option("--json", "Print one multix.result/v1 JSON envelope on stdout");
  if (has("--dry-run")) ownDryRun.add(cmd);
  else cmd.option("--dry-run", "Validate and show the first provider request without sending it");
  for (const sub of cmd.commands) addGlobalFlags(sub);
}

function captureStreams(): void {
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (run.json) {
      run.stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(),
      );
      const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      cb?.();
      return true;
    }
    // biome-ignore lint/suspicious/noExplicitAny: pass-through of the original signature
    return (realStdoutWrite as any)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    run.stderr.push(text);
    if (run.stderr.length > 400) run.stderr.splice(0, run.stderr.length - 400);
    for (const line of stripAnsi(text).split("\n")) {
      const m = line.match(/^\s*(?:✗|Error:|error:)\s*(.+)$/);
      if (m?.[1]) run.lastErrorLine = m[1].trim();
    }
    if (run.json && !run.verbose) {
      const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      cb?.();
      return true;
    }
    // biome-ignore lint/suspicious/noExplicitAny: pass-through of the original signature
    return (realStderrWrite as any)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

function writeOut(text: string): void {
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return;
    }
  }
}

function logWarnings(): Array<{ code: "LOG_WARNING"; message: string }> {
  const out: Array<{ code: "LOG_WARNING"; message: string }> = [];
  for (const line of stripAnsi(run.stderr.join("")).split("\n")) {
    const m = line.match(/^\s*⚠\s*(.+)$/);
    if (m?.[1] && out.length < 5) out.push({ code: "LOG_WARNING", message: m[1].trim() });
  }
  return out;
}

interface FinalizeInput {
  exitCode: number;
  error?: unknown;
  dryRunRequest?: DryRunRequest;
  dryRunLocal?: boolean;
}

/** Build the envelope, record history, print it (JSON) or the hint (text). Returns the exit code. */
export function finalizeRun(input: FinalizeInput): number {
  if (run.finalized) return input.exitCode;
  run.finalized = true;
  const dryRun = Boolean(input.dryRunRequest || input.dryRunLocal);
  const failed = !dryRun && (input.exitCode !== 0 || input.error !== undefined);
  let info: ErrorInfo | undefined;
  if (failed) {
    info =
      input.error !== undefined
        ? classifyError(input.error)
        : classifyMessage(run.lastErrorLine ?? `Command exited with code ${input.exitCode}`);
  }
  const exitCode = !failed
    ? 0
    : info?.code === "UNKNOWN"
      ? input.exitCode || 1
      : (info?.exit_code ?? 1);

  const warnings: OutputWarning[] = [];
  const extra = typeof run.options.output === "string" ? [run.options.output] : [];
  const outputs: OutputFile[] = dryRun
    ? []
    : producedFiles(extra).flatMap((file) => {
        try {
          return [inspectOutput(file, warnings)];
        } catch {
          return [];
        }
      });

  const recorded = Boolean(run.command) && !UNRECORDED.test(run.command);
  const historyId = recorded ? newHistoryId(run.startedAt) : undefined;
  const optionModel = typeof run.options.model === "string" ? run.options.model : undefined;
  const model = run.requestModel ?? optionModel;
  const usage = summarizeUsage();
  const httpErrors = run.calls.filter((c) => c.status === 0 || c.status >= 400).length;
  const http = run.calls.length
    ? {
        requests: run.calls.length,
        errors: httpErrors,
        ms: run.calls.reduce((s, c) => s + c.ms, 0),
      }
    : undefined;
  const duration = Date.now() - run.startedAt;

  const next = [
    ...(info ? nextForError(info, run.command, run.group, historyId) : []),
    ...suggestedCommands([...run.stdout, ...run.stderr], run.command),
  ];
  if (dryRun)
    next.unshift(`multix ${redactArgv(run.argv.filter((a) => a !== "--dry-run")).join(" ")}`);

  if (recorded && historyId) {
    appendHistory({
      v: 1,
      id: historyId,
      ts: new Date(run.startedAt).toISOString(),
      duration_ms: duration,
      cwd: process.cwd(),
      version,
      command: run.command,
      provider: run.group,
      ...(model ? { model } : {}),
      argv: redactArgv(run.argv),
      ok: !failed,
      exit_code: exitCode,
      ...(dryRun ? { dry_run: true } : {}),
      ...(info ? { error: { code: info.code, message: info.message.slice(0, 500) } } : {}),
      ...(outputs.length
        ? {
            outputs: outputs.map((o) => ({
              path: o.path,
              bytes: o.bytes,
              ...(o.sha256 ? { sha256: o.sha256 } : {}),
              ...(o.duration_s !== undefined ? { duration_s: o.duration_s } : {}),
            })),
          }
        : {}),
      ...(usage ? { usage } : {}),
      ...(http ? { http } : {}),
      ...(run.ids.length ? { provider_ids: run.ids } : {}),
    });
  }

  if (run.json) {
    const allWarnings = [...warnings, ...logWarnings()];
    const { exit_code: _drop, ...error } = info ?? ({} as ErrorInfo);
    const envelope: ResultEnvelope = {
      schema: ENVELOPE_SCHEMA,
      ok: !failed,
      command: run.command,
      ...(run.group ? { provider: run.group } : {}),
      ...(model ? { model } : {}),
      ...(dryRun ? { dry_run: true } : {}),
      duration_ms: duration,
      outputs,
      ...(allWarnings.length ? { warnings: allWarnings } : {}),
      ...stdoutPayload(run.stdout),
      ...(info ? { error } : {}),
      exit_code: exitCode,
      ...(usage ? { usage } : {}),
      ...(http ? { http } : {}),
      ...(run.ids.length ? { provider_ids: run.ids } : {}),
      ...(input.dryRunRequest ? { request: input.dryRunRequest } : {}),
      ...(historyId ? { history_id: historyId } : {}),
      next: [...new Set(next)],
      ...(failed
        ? {
            log: stripAnsi(run.stderr.join(""))
              .split("\n")
              .map((l) => l.trimEnd())
              .filter(Boolean)
              .slice(-15),
          }
        : {}),
    };
    writeOut(`${JSON.stringify(envelope)}\n`);
  } else if (info) {
    const retry = info.retryable
      ? `, retryable${info.retry_after_s ? ` after ${info.retry_after_s}s` : ""}`
      : "";
    const lines = [`  code: ${info.code} (exit ${exitCode}${retry})`, `  hint: ${info.hint}`];
    if (input.error !== undefined && !run.lastErrorLine) lines.unshift(`Error: ${info.message}`);
    for (const cmd of [...new Set(next)].slice(0, 3)) lines.push(`  next: ${cmd}`);
    realStderrWrite(`${lines.join("\n")}\n`);
  } else if (dryRun) {
    const req = input.dryRunRequest;
    realStderrWrite(
      req
        ? `Dry run: would send ${req.method} ${req.url}${req.body ? `\n${JSON.stringify(req.body, null, 2)}` : ""}\n`
        : `Dry run: ${run.command} runs locally; options are valid.\n`,
    );
  }
  return exitCode;
}

export function installAgentRuntime(program: Command, cliVersion: string): void {
  version = cliVersion;
  run.argv = process.argv.slice(2);
  run.json = flagInArgv(run.argv, "--json") || process.env.MULTIX_OUTPUT?.toLowerCase() === "json";
  run.verbose = flagInArgv(run.argv, "--verbose") || flagInArgv(run.argv, "-v");

  addGlobalFlags(program);
  setCommand(commandFromArgv(program, run.argv));
  captureStreams();
  installOutputFileTracker();
  installFetchTelemetry((request) =>
    realExit(finalizeRun({ exitCode: 0, dryRunRequest: request })),
  );

  process.exit = ((code?: number | string | null) => {
    const numeric = typeof code === "number" ? code : Number(code ?? process.exitCode ?? 0) || 0;
    return realExit(finalizeRun({ exitCode: numeric }));
  }) as typeof process.exit;

  program.hook("preAction", (_root, action) => {
    const names = commandPath(action);
    setCommand(names);
    run.options = action.opts();
    run.dryRun = Boolean(run.options.dryRun) && !ownDryRun.has(action);
    if (run.dryRun && LOCAL_GROUPS.has(names[0] ?? "")) {
      realExit(finalizeRun({ exitCode: 0, dryRunLocal: true }));
    }
  });
  program.hook("postAction", () => {
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = finalizeRun({ exitCode: code });
  });
}

/** Top-level error handler: classify, print, exit. */
export function exitWithError(error: unknown): never {
  return realExit(finalizeRun({ exitCode: 1, error }));
}
