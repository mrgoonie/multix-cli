/**
 * The `multix.result/v1` envelope: one JSON object per command run, the same
 * shape for success, failure and dry runs, so an agent reads `ok`, `outputs`,
 * `error.code` and `next` instead of parsing provider-specific prose.
 */

import type { CostEstimate } from "../budget/cost-estimate.js";
import type { CostReceipt } from "../budget/cost-receipt.js";
import type { ErrorInfo } from "../core/error-classify.js";
import type { DryRunRequest } from "./fetch-telemetry.js";
import type { OutputFile, OutputWarning } from "./output-file-inspect.js";
import type { UsageSummary } from "./run-state.js";

export interface JobIdentity {
  provider: string;
  id: string;
  /** 1, or 1 plus the failed calls to the same endpoint the command retried first. */
  attempt: number;
}

export const ENVELOPE_SCHEMA = "multix.result/v1";

export interface ResultEnvelope {
  schema: typeof ENVELOPE_SCHEMA;
  ok: boolean;
  command: string;
  provider?: string;
  /** The requested model (kept for compatibility; same value as `model_requested`). */
  model?: string;
  /** Model the run asked for: from the request body or path, else `--model`. */
  model_requested?: string | null;
  /** Model the provider reported serving; `null` when no response named one. */
  model_resolved?: string | null;
  /** Provider job or request id behind the run's outputs. */
  job?: JobIdentity;
  dry_run?: boolean;
  /** `--estimate`: priced only, nothing sent. */
  estimate_only?: boolean;
  duration_ms: number;
  outputs: OutputFile[];
  warnings?: Array<OutputWarning | { code: "LOG_WARNING"; message: string }>;
  /** Parsed stdout when the command printed JSON. */
  data?: unknown;
  /** stdout text when it was not JSON (analysis, transcripts, ids). */
  text?: string;
  text_truncated?: boolean;
  error?: Omit<ErrorInfo, "exit_code">;
  exit_code: number;
  usage?: UsageSummary;
  http?: { requests: number; errors: number; ms: number };
  provider_ids?: string[];
  /** Pre-flight price of the run (range, units, rate and its source). */
  estimate?: CostEstimate;
  /** `--max-cost` verdict. */
  budget?: { ok: boolean; max_cost_usd: number; policy: string; code?: string; message?: string };
  /** Reconciled cost: estimate, provider-reported, actual, variance, operation id. */
  cost?: CostReceipt;
  /** The first request a dry run would have sent (query strings and secrets removed). */
  request?: DryRunRequest;
  history_id?: string;
  /** Commands worth running next, most relevant first. */
  next: string[];
  /** Last stderr lines, on failure only. */
  log?: string[];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const TEXT_LIMIT = 32_000;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** stdout as data (JSON) or text, capped. */
export function stdoutPayload(
  chunks: string[],
): Pick<ResultEnvelope, "data" | "text" | "text_truncated"> {
  const raw = stripAnsi(chunks.join("")).trim();
  if (!raw) return {};
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return { data: JSON.parse(raw) };
    } catch {}
  }
  if (raw.length > TEXT_LIMIT) return { text: raw.slice(0, TEXT_LIMIT), text_truncated: true };
  return { text: raw };
}

/** `multix ...` commands the run printed as follow-ups (status/resume/download hints). */
export function suggestedCommands(
  texts: string[],
  current: string,
  known?: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const re = /\bmultix\s+[a-z0-9][a-z0-9-]*(?:\s+[^\s`'"|;]+)*/g;
  for (const text of texts) {
    for (const line of stripAnsi(text).split("\n")) {
      for (const match of line.matchAll(re)) {
        const cmd = match[0].replace(/[.,:;)\]]+$/, "").trim();
        const words = cmd.split(/\s+/);
        if (known && !known.has(words[1] ?? "")) continue;
        if (words.length < 3 && !/check|models|history/.test(cmd)) continue;
        if (cmd === `multix ${current}` || found.includes(cmd)) continue;
        found.push(cmd);
      }
    }
  }
  return found.slice(0, 4);
}

/** Task a command serves, from its name (used to suggest alternatives). */
export function taskOf(command: string): string | undefined {
  const leaf = command.split(" ").pop() ?? "";
  if (command.startsWith("speech ")) return "speech";
  if (/image-to-video|i2v|reference-to-video/.test(leaf)) return "image-to-video";
  if (/video|motion/.test(leaf)) return "video";
  if (/image-to-image|edit|variation|upscale/.test(leaf)) return "image-edit";
  if (/speech|tts/.test(leaf)) return "speech";
  if (/transcribe|stt/.test(leaf)) return "transcription";
  if (/music/.test(leaf)) return "music";
  if (/3d/.test(leaf)) return "3d";
  if (/^(generate|image)$/.test(leaf)) return "image";
  return undefined;
}

/** Next steps for a failure, by error code. */
export function nextForError(
  info: ErrorInfo,
  command: string,
  group: string,
  historyId: string | undefined,
): string[] {
  const task = taskOf(command);
  switch (info.code) {
    case "MISSING_KEY":
    case "INVALID_KEY":
    case "CONFIG_ERROR":
      return ["multix check", ...(task ? [`multix models --task ${task} --ready`] : [])];
    case "QUOTA_EXCEEDED":
      return [task ? `multix models --task ${task} --ready` : "multix models --ready"];
    case "MODEL_NOT_FOUND":
      return [`multix models --provider ${group}`];
    case "USAGE":
    case "INVALID_INPUT":
      return command ? [`multix ${command} --help`] : ["multix --help"];
    case "RATE_LIMITED":
    case "NETWORK_ERROR":
    case "PROVIDER_UNAVAILABLE":
      return historyId ? [`multix rerun ${historyId}`] : [];
    default:
      return [];
  }
}
