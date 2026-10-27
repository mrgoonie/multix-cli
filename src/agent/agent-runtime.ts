/**
 * Agent runtime for the CLI process. Installed once by cli.ts, it gives every
 * command, without per-command code:
 * - `--json` (or MULTIX_OUTPUT=json): one `multix.result/v1` envelope on stdout,
 *   human output captured instead of printed;
 * - `--dry-run`: local validation runs, then the first network request is
 *   reported instead of sent (local `media` commands stop before running);
 * - classified errors with hint and next steps, and exit codes by class;
 * - `--estimate` (price the run, send nothing) and `--max-cost` / `--cost-policy`
 *   (refuse before sending when the cost cannot be kept under the limit);
 * - a history entry with outputs, usage (tokens, cost, credits, timings) and
 *   a reconciled cost receipt.
 * Commands that call process.exit() directly are covered by wrapping it.
 */

import fs from "node:fs";
import type { Command } from "commander";
import {
  type ErrorInfo,
  classifyError,
  classifyMessage,
  classifySignalExit,
} from "../core/error-classify.js";
import { setExternalRunGuard } from "../core/external-run-guard.js";
import { redactUrlsInText } from "../core/redact.js";
import { costReceiptFor, formatEstimate, formatReceipt, preflightCost } from "./cost-preflight.js";
import { type DryRunRequest, installFetchTelemetry, settleTelemetry } from "./fetch-telemetry.js";
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
/** Read-only lookups that report another run's spend: counting it here would bill it twice in history. */
const SPEND_LOOKUPS = /^openrouter generation\b/;
/** Groups that run locally (ffmpeg/ImageMagick): dry run stops before the action. */
const LOCAL_GROUPS = new Set(["media"]);
/** Exit statuses of a run stopped by SIGHUP, SIGINT or SIGTERM (128 + the signal number). */
const SIGNAL_EXITS = new Set([129, 130, 143]);

let version = "0.0.0";
/** Top-level command names, so printed prose is not mistaken for a command. */
let knownGroups = new Set<string>();
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

/** Groups where a dry run means nothing (no provider request, or their own flag). */
const NO_DRY_RUN_GROUPS = new Set(["check", "models", "guide", "history", "rerun"]);

/**
 * Add --json to every command, and --dry-run plus the cost flags to every
 * command that can send a provider request.
 */
function addGlobalFlags(cmd: Command, group = ""): void {
  const has = (flag: string) => cmd.options.some((o) => o.long === flag);
  if (!has("--json")) cmd.option("--json", "Print one multix.result/v1 JSON envelope on stdout");
  const sendsRequests = Boolean(group) && !NO_DRY_RUN_GROUPS.has(group);
  if (has("--dry-run")) ownDryRun.add(cmd);
  else if (sendsRequests) {
    cmd.option("--dry-run", "Validate and show the first provider request without sending it");
  }
  const billable = sendsRequests && !LOCAL_GROUPS.has(group) && !NON_PROVIDER_GROUPS.has(group);
  if (billable && cmd.commands.length === 0) {
    if (!has("--estimate")) {
      cmd.option("--estimate", "Price the run (range, units, rate source) without sending it");
    }
    if (!has("--max-cost")) {
      cmd.option("--max-cost <usd>", "Refuse to send unless the cost is at most this many USD");
    }
    if (!has("--cost-policy")) {
      cmd.option(
        "--cost-policy <policy>",
        "With --max-cost: strict (proven ceiling only) or estimate (accept the estimated high end)",
      );
    }
  }
  for (const sub of cmd.commands) addGlobalFlags(sub, group || sub.name());
}

/** Quote one argument for a POSIX shell when it needs it. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** argv without --max-cost / --cost-policy and their values. */
function withoutCostLimit(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--max-cost" || arg === "--cost-policy") i++;
    else if (!arg.startsWith("--max-cost=") && !arg.startsWith("--cost-policy=")) out.push(arg);
  }
  return out;
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
  /** `--estimate`: priced before the action, nothing sent. */
  estimateOnly?: boolean;
}

/** Build the envelope, record history, print it (JSON) or the hint (text). Returns the exit code. */
export function finalizeRun(input: FinalizeInput): number {
  if (run.finalized) return input.exitCode;
  run.finalized = true;
  const dryRun = Boolean(input.dryRunRequest || input.dryRunLocal);
  const estimateOnly = Boolean(input.estimateOnly);
  const notSent = dryRun || estimateOnly;
  const failed = !notSent && (input.exitCode !== 0 || input.error !== undefined);
  let info: ErrorInfo | undefined;
  if (failed) {
    info =
      input.error !== undefined
        ? classifyError(input.error)
        : (classifySignalExit(
            input.exitCode,
            run.requestsStarted > 0 || run.externalRuns.length > 0,
          ) ?? classifyMessage(run.lastErrorLine ?? `Command exited with code ${input.exitCode}`));
  }
  // A job submitted before the signal keeps running and is billed: resume it, never rerun.
  const inFlight =
    info && input.error === undefined && SIGNAL_EXITS.has(input.exitCode)
      ? run.inFlight
      : undefined;
  if (info && inFlight) {
    info = {
      ...info,
      retryable: false,
      hint: `Job ${inFlight.id} was submitted before the run stopped; it runs on (or has finished) and is billed. Do not rerun; resume it with the next command.`,
    };
  } else if (
    info &&
    run.interrupted &&
    input.error === undefined &&
    SIGNAL_EXITS.has(input.exitCode)
  ) {
    info = { ...info, ...run.interrupted };
  }
  // Exit classes (2-6) are part of agent mode; plain runs keep the historical exit 1.
  // An unclassified failure keeps the command's own status in both modes.
  const jsonExitCode = info?.code === "UNKNOWN" ? input.exitCode || 1 : (info?.exit_code ?? 1);
  const exitCode = !failed ? 0 : run.json ? jsonExitCode : input.exitCode || 1;

  const warnings: OutputWarning[] = [];
  const extra = typeof run.options.output === "string" ? [run.options.output] : [];
  const outputs: OutputFile[] = notSent
    ? []
    : producedFiles(extra).flatMap((file) => {
        try {
          return [inspectOutput(file, warnings)];
        } catch {
          return [];
        }
      });

  // Help output and --version never reach an action; parse errors are kept (they measure misuse).
  const recorded =
    Boolean(run.command) && !UNRECORDED.test(run.command) && (run.actionStarted || failed);
  const historyId = recorded ? newHistoryId(run.startedAt) : undefined;
  const optionModel = typeof run.options.model === "string" ? run.options.model : undefined;
  const model = run.requestModel ?? optionModel;
  const usage = SPEND_LOOKUPS.test(run.command) ? undefined : summarizeUsage();
  const httpErrors = run.calls.filter((c) => c.status === 0 || c.status >= 400).length;
  const http = run.calls.length
    ? {
        requests: run.calls.length,
        errors: httpErrors,
        ms: run.calls.reduce((s, c) => s + c.ms, 0),
      }
    : undefined;
  const duration = Date.now() - run.startedAt;
  const cost = costReceiptFor({ failed, notSent, historyId, model, usage });

  const next = [
    ...(inFlight ? [inFlight.resume] : []),
    ...(info ? nextForError(info, run.command, run.group, historyId) : []),
    ...suggestedCommands([...run.stdout, ...run.stderr], run.command, knownGroups),
  ];
  if (info?.code === "BUDGET_EXCEEDED" || info?.code === "BUDGET_UNPROVEN") {
    next.unshift(
      `multix ${redactArgv(withoutCostLimit(run.argv)).map(shellQuote).join(" ")} --estimate`,
    );
  }
  if (notSent) {
    const flag = estimateOnly ? "--estimate" : "--dry-run";
    const args = redactArgv(run.argv.filter((a) => a !== flag));
    next.unshift(`multix ${args.map(shellQuote).join(" ")}`);
  }

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
      ...(estimateOnly ? { estimate_only: true } : {}),
      ...(info ? { error: { code: info.code, message: info.message.slice(0, 500) } } : {}),
      ...(outputs.length
        ? {
            outputs: outputs.map((o) => ({
              path: o.path,
              bytes: o.bytes,
              mime: o.mime,
              ...(o.sha256 ? { sha256: o.sha256 } : {}),
              ...(o.duration_s !== undefined ? { duration_s: o.duration_s } : {}),
            })),
          }
        : {}),
      ...(usage ? { usage } : {}),
      ...(http ? { http } : {}),
      ...(run.ids.length ? { provider_ids: run.ids } : {}),
      ...(cost ? { cost } : {}),
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
      ...(estimateOnly ? { estimate_only: true } : {}),
      duration_ms: duration,
      outputs,
      ...(allWarnings.length ? { warnings: allWarnings } : {}),
      ...(run.data !== undefined ? { data: run.data } : stdoutPayload(run.stdout)),
      ...(info ? { error } : {}),
      exit_code: exitCode,
      ...(usage ? { usage } : {}),
      ...(http ? { http } : {}),
      ...(run.ids.length ? { provider_ids: run.ids } : {}),
      ...(run.estimate ? { estimate: run.estimate } : {}),
      ...(run.budget ? { budget: run.budget } : {}),
      ...(cost ? { cost } : {}),
      ...(input.dryRunRequest ? { request: input.dryRunRequest } : {}),
      ...(historyId ? { history_id: historyId } : {}),
      next: [...new Set(next)],
      ...(failed
        ? {
            log: redactUrlsInText(stripAnsi(run.stderr.join("")))
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
    const lines = [
      `  code: ${info.code} (exit ${jsonExitCode} with --json${retry})`,
      `  hint: ${info.hint}`,
    ];
    if (input.error !== undefined && !run.lastErrorLine) lines.unshift(`Error: ${info.message}`);
    for (const cmd of [...new Set(next)].slice(0, 3)) lines.push(`  next: ${cmd}`);
    if (cost?.status === "uncertain") lines.push(`  cost: uncertain — ${cost.reason}`);
    realStderrWrite(`${lines.join("\n")}\n`);
  } else if (estimateOnly && run.estimate) {
    realStdoutWrite(formatEstimate(run.estimate, run.budget));
  } else if (dryRun) {
    const req = input.dryRunRequest;
    realStderrWrite(
      req
        ? `Dry run: would send ${req.method} ${req.url}${req.body ? `\n${JSON.stringify(req.body, null, 2)}` : ""}\n`
        : `Dry run: ${run.command} runs locally; options are valid.\n`,
    );
  } else if (cost) {
    const line = formatReceipt(cost);
    if (line) realStderrWrite(line);
  }
  return exitCode;
}

export function installAgentRuntime(program: Command, cliVersion: string): void {
  version = cliVersion;
  run.argv = process.argv.slice(2);
  run.json = flagInArgv(run.argv, "--json") || process.env.MULTIX_OUTPUT?.toLowerCase() === "json";
  run.verbose = flagInArgv(run.argv, "--verbose") || flagInArgv(run.argv, "-v");

  for (const cmd of program.commands) addGlobalFlags(cmd, cmd.name());
  knownGroups = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]));
  setCommand(commandFromArgv(program, run.argv));
  captureStreams();
  installOutputFileTracker();
  installFetchTelemetry((request) =>
    realExit(finalizeRun({ exitCode: 0, dryRunRequest: request })),
  );
  // Paid work outside fetch (the Codex image driver) stops here in a dry run.
  setExternalRunGuard(({ program: name, args }) => {
    if (!run.dryRun) {
      run.externalRuns.push(name);
      return;
    }
    const body = args.map((a) => (a.length > 400 ? `<${a.length} chars>` : a));
    realExit(finalizeRun({ exitCode: 0, dryRunRequest: { method: "EXEC", url: name, body } }));
  });

  process.exit = ((code?: number | string | null) => {
    const numeric = typeof code === "number" ? code : Number(code ?? process.exitCode ?? 0) || 0;
    return realExit(finalizeRun({ exitCode: numeric }));
  }) as typeof process.exit;

  program.hook("preAction", (_root, action) => {
    const names = commandPath(action);
    setCommand(names);
    run.actionStarted = true;
    run.options = action.opts();
    run.dryRun = Boolean(run.options.dryRun) && !ownDryRun.has(action);
    if (run.dryRun && LOCAL_GROUPS.has(names[0] ?? "")) {
      realExit(finalizeRun({ exitCode: 0, dryRunLocal: true }));
    }
    // Throws BudgetError (classified, nothing sent) when --max-cost refuses.
    if (preflightCost()) realExit(finalizeRun({ exitCode: 0, estimateOnly: true }));
  });
  program.hook("postAction", async () => {
    await settleTelemetry();
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = finalizeRun({ exitCode: code });
  });
}

/** Top-level error handler: classify, print, exit. */
export function exitWithError(error: unknown): never {
  return realExit(finalizeRun({ exitCode: 1, error }));
}
