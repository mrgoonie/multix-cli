/**
 * Stable error taxonomy for agents (runtime-neutral, no node:* imports so the
 * MCP Worker can reuse it). Maps any thrown error, or the text a command
 * logged before exiting, to a code, a retry decision, a one-line hint and an
 * exit code class.
 */

import {
  BudgetError,
  HttpError,
  MultixError,
  ProviderJobFailedError,
  ResponseTooLargeError,
} from "./errors.js";
import { redactUrlsInText } from "./redact.js";

export type ErrorCode =
  | "USAGE"
  | "INVALID_INPUT"
  | "MISSING_KEY"
  | "INVALID_KEY"
  | "CONFIG_ERROR"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "CONTENT_BLOCKED"
  | "MODEL_NOT_FOUND"
  | "NOT_FOUND"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_REMOTE_STATE"
  | "JOB_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "BINARY_MISSING"
  | "BUDGET_EXCEEDED"
  | "BUDGET_UNPROVEN"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * Process exit codes by class: 0 ok, 1 unknown, 2 usage or invalid input,
 * 3 missing/invalid key or config, 4 temporary (retry may succeed),
 * 5 rejected by the provider (do not retry unchanged), 6 timed out while the
 * job may still be running (resume it, do not resubmit). A run cancelled by a
 * signal keeps the shell's 128 + signal number (129 SIGHUP, 130 SIGINT, 143 SIGTERM).
 */
export const EXIT_CODES = {
  ok: 0,
  unknown: 1,
  usage: 2,
  config: 3,
  retryable: 4,
  rejected: 5,
  timeout: 6,
  /** Default only: classifySignalExit reports the signal's own status (129, 130 or 143). */
  cancelled: 130,
} as const;

/** Exit statuses of a run stopped by a signal, as a shell reports them (128 + the signal number). */
const SIGNAL_BY_EXIT: Record<number, string> = { 129: "SIGHUP", 130: "SIGINT", 143: "SIGTERM" };

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Seconds to wait before retrying, when the provider said so. */
  retry_after_s?: number;
  hint: string;
  exit_code: number;
  /** HTTP status of the failed provider call, when known. */
  http_status?: number;
  /** Env variable the message names (e.g. GEMINI_API_KEY), when any. */
  env?: string;
}

const HINTS: Record<ErrorCode, string> = {
  USAGE: "Fix the command line; run the command with --help for its flags.",
  INVALID_INPUT: "Fix the flagged input; nothing was billed. Check flags with --help.",
  MISSING_KEY:
    "Set the named key in ~/.multix/.env (or the project .env), then run `multix check`.",
  INVALID_KEY: "The provider rejected the key: check or rotate it, then run `multix check`.",
  CONFIG_ERROR: "Fix the configuration named in the message, then run `multix check`.",
  RATE_LIMITED: "Wait retry_after_s (or back off) and retry the same command.",
  QUOTA_EXCEEDED:
    "Out of quota or credits: top up, or switch provider with `multix models --task <task> --ready`.",
  CONTENT_BLOCKED: "The provider's safety filter refused it: rephrase; do not retry unchanged.",
  MODEL_NOT_FOUND: "Pick a valid model: `multix models --provider <group>` lists the known ones.",
  NOT_FOUND: "The file, job or resource does not exist; check the id or path.",
  PROVIDER_REJECTED: "The provider rejected the request; read the message and fix the input.",
  PROVIDER_UNAVAILABLE: "Provider error on their side: retry later or switch provider.",
  NETWORK_ERROR: "Network failure: retry; check connectivity if it persists.",
  TIMEOUT:
    "Timed out waiting; the job may still be running: use the status/resume command, do not resubmit.",
  UNKNOWN_REMOTE_STATE:
    "The submit was cut off before the provider answered, so it may have been queued: check the provider's request list before resubmitting, or you may pay twice.",
  JOB_FAILED: "The provider reported the job failed; read the message, adjust inputs and retry.",
  RESPONSE_TOO_LARGE: "The response exceeded the size cap; request fewer or smaller outputs.",
  BINARY_MISSING: "Install the missing tool (ffmpeg, ImageMagick or cwebp) and put it on PATH.",
  BUDGET_EXCEEDED:
    "Nothing was sent: the estimate is over --max-cost. Raise the limit, shorten the input or pick a cheaper model (see --estimate).",
  BUDGET_UNPROVEN:
    "Nothing was sent: the cost cannot be bounded. Check --estimate; pass --cost-policy estimate to accept an estimated high end, or drop --max-cost.",
  CANCELLED: "The run was cancelled; nothing was left behind. Rerun the command.",
  UNKNOWN: "Read the message; rerun with --verbose for details.",
};

const EXIT_BY_CODE: Record<ErrorCode, number> = {
  USAGE: EXIT_CODES.usage,
  INVALID_INPUT: EXIT_CODES.usage,
  MISSING_KEY: EXIT_CODES.config,
  INVALID_KEY: EXIT_CODES.config,
  CONFIG_ERROR: EXIT_CODES.config,
  RATE_LIMITED: EXIT_CODES.retryable,
  PROVIDER_UNAVAILABLE: EXIT_CODES.retryable,
  NETWORK_ERROR: EXIT_CODES.retryable,
  QUOTA_EXCEEDED: EXIT_CODES.rejected,
  CONTENT_BLOCKED: EXIT_CODES.rejected,
  MODEL_NOT_FOUND: EXIT_CODES.rejected,
  NOT_FOUND: EXIT_CODES.rejected,
  PROVIDER_REJECTED: EXIT_CODES.rejected,
  JOB_FAILED: EXIT_CODES.rejected,
  RESPONSE_TOO_LARGE: EXIT_CODES.rejected,
  TIMEOUT: EXIT_CODES.timeout,
  UNKNOWN_REMOTE_STATE: EXIT_CODES.timeout,
  BINARY_MISSING: EXIT_CODES.config,
  BUDGET_EXCEEDED: EXIT_CODES.usage,
  BUDGET_UNPROVEN: EXIT_CODES.usage,
  CANCELLED: EXIT_CODES.cancelled,
  UNKNOWN: EXIT_CODES.unknown,
};

const RETRYABLE = new Set<ErrorCode>([
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "NETWORK_ERROR",
  "TIMEOUT",
]);

const ENV_NAME = /\b([A-Z][A-Z0-9]*_(?:API_KEY|API_TOKEN|API_SECRET|KEY|TOKEN|SECRET|ID))\b/;

// Message patterns, checked in order; the first match wins.
const TEXT_RULES: Array<[RegExp, ErrorCode]> = [
  // Spend guard refusals (BudgetError) keep their code when only the message travels (MCP).
  [/^Refusing to run: .*exceeds --max-cost/, "BUDGET_EXCEEDED"],
  [/^Refusing to run: /, "BUDGET_UNPROVEN"],
  // A rejected flag value ("Invalid --wait-timeout: abc") is input, whatever the flag is named.
  [/^invalid --[\w-]+/i, "INVALID_INPUT"],
  [
    /(?:^|error: )(unknown option|unknown command|required option|missing required argument|too many arguments|option .* argument missing|option '.*' argument)/i,
    "USAGE",
  ],
  [
    /\b(ffmpeg|ffprobe|magick|imagemagick|cwebp)\b.*\b(not found|missing|ENOENT|install)/i,
    "BINARY_MISSING",
  ],
  [
    /(is not set|not configured|missing (api )?key|no api key|requires? [A-Z0-9_]+_(KEY|TOKEN|SECRET)|set [A-Z0-9_]+_(KEY|TOKEN))/i,
    "MISSING_KEY",
  ],
  [
    /(invalid|incorrect|expired|revoked) (api )?(key|token)|unauthori[sz]ed|authentication/i,
    "INVALID_KEY",
  ],
  [
    // A logged job failure is the provider's verdict, whatever reason its payload names
    // (moderation, quota, an internal timeout). An id between noun and verb must hold a
    // digit, so "task polling failed" is not one; a payload whose status is canceled is not.
    /^(?!.*"status"\s*:\s*"(?:cancell?ed|aborted)")(?:.*\b(task|job|prediction|generation|interaction) (?:(?=[\w.:-]*\d)[\w.:-]+ )?(failed|was canceled|errored)|.*status:? ?"?failed)/is,
    "JOB_FAILED",
  ],
  [
    /(safety|content policy|moderation|blocked|nsfw|prohibited|sensitive content|responsible ai|flagged)/i,
    "CONTENT_BLOCKED",
  ],
  [
    /(quota|insufficient (credit|balance|funds)|out of credits|billing|payment[ _]required|exceeded your)/i,
    "QUOTA_EXCEEDED",
  ],
  [/(rate.?limit|too many requests)/i, "RATE_LIMITED"],
  [/(timed out|timeout|deadline exceeded)/i, "TIMEOUT"],
  [
    /(model).{0,40}(not found|does not exist|unknown|not supported|invalid)|(unknown|invalid) model/i,
    "MODEL_NOT_FOUND",
  ],
  [/(ENOENT|no such file|file not found|does not exist)/i, "NOT_FOUND"],
  [
    /(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up)/i,
    "NETWORK_ERROR",
  ],
  [
    /(invalid|must be|required|unknown option|too many|at most|at least|expected|not allowed|unsupported|provide --|cannot be combined|missing required)/i,
    "INVALID_INPUT",
  ],
];

/** Messages leave here for the JSON envelope, stderr and the run ledger: redact URL query strings. */
function build(code: ErrorCode, message: string, extra: Partial<ErrorInfo> = {}): ErrorInfo {
  const env = message.match(ENV_NAME)?.[1];
  return {
    code,
    message: redactUrlsInText(message),
    retryable: RETRYABLE.has(code),
    hint: HINTS[code],
    exit_code: EXIT_BY_CODE[code],
    ...(env ? { env } : {}),
    ...extra,
  };
}

function codeFromText(text: string): ErrorCode | undefined {
  for (const [re, code] of TEXT_RULES) if (re.test(text)) return code;
  return undefined;
}

/** Classify an HTTP status with its body snippet. */
export function codeFromHttp(status: number, body: string): ErrorCode {
  const fromText = codeFromText(body);
  if (status === 0) return fromText === "TIMEOUT" ? "TIMEOUT" : "NETWORK_ERROR";
  if (status === 401) return "INVALID_KEY";
  if (status === 402) return "QUOTA_EXCEEDED";
  if (status === 403) {
    if (fromText === "QUOTA_EXCEEDED" || fromText === "CONTENT_BLOCKED") return fromText;
    return "INVALID_KEY";
  }
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return fromText === "QUOTA_EXCEEDED" ? "QUOTA_EXCEEDED" : "RATE_LIMITED";
  if (status === 404) return fromText === "MODEL_NOT_FOUND" ? "MODEL_NOT_FOUND" : "NOT_FOUND";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  if (fromText === "CONTENT_BLOCKED" || fromText === "QUOTA_EXCEEDED") return fromText;
  if (fromText === "MODEL_NOT_FOUND") return fromText;
  return "PROVIDER_REJECTED";
}

/**
 * Classify a run that exited with a signal's status (129, 130 or 143); undefined for any
 * other code. `providerContacted`: a request already reached a provider, so a paid job may
 * have been accepted and rerunning blindly could pay twice.
 */
export function classifySignalExit(
  exitCode: number,
  providerContacted = false,
): ErrorInfo | undefined {
  const signal = SIGNAL_BY_EXIT[exitCode];
  if (!signal) return undefined;
  return build("CANCELLED", `Cancelled by ${signal} (exit ${exitCode})`, {
    exit_code: exitCode,
    ...(providerContacted
      ? {
          hint: "The run was cancelled after a provider request was sent, so a paid job may already exist: check provider_ids or the provider's request list and fetch the result before rerunning, or you may pay twice.",
        }
      : {}),
  });
}

/** Classify a log line or error message alone (no error object). */
export function classifyMessage(message: string): ErrorInfo {
  const http = message.match(/\bHTTP (\d{3})\b/);
  if (http?.[1]) {
    const status = Number(http[1]);
    return build(codeFromHttp(status, message), message, { http_status: status });
  }
  return build(codeFromText(message) ?? "UNKNOWN", message);
}

/** Classify any thrown value. */
export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof HttpError) {
    const code = codeFromHttp(error.status, error.snippet);
    const extra: Partial<ErrorInfo> = { http_status: error.status || undefined };
    if (error.retryAfterMs !== undefined)
      extra.retry_after_s = Math.ceil(error.retryAfterMs / 1000);
    return build(code, error.message, extra);
  }
  if (error instanceof ResponseTooLargeError) return build("RESPONSE_TOO_LARGE", error.message);
  const message = error instanceof Error ? error.message : String(error);
  const commanderCode = (error as { code?: unknown } | null)?.code;
  if (typeof commanderCode === "string" && commanderCode.startsWith("commander.")) {
    return build("USAGE", message.replace(/^error: /, ""));
  }
  if (error instanceof ProviderJobFailedError) {
    // The provider's own reason (moderation, quota) is in the message; the run is a failed job.
    if (error.terminal) return build("JOB_FAILED", message);
    // Canceled, paused or unusable output: never reported as a failed job, whatever the text says.
    const info = classifyMessage(message);
    return info.code === "JOB_FAILED" ? build("UNKNOWN", message) : info;
  }
  if (error instanceof MultixError) {
    if (error.code === "CONFIG_ERROR") {
      const code = codeFromText(message);
      return build(
        code === "MISSING_KEY" || code === "INVALID_KEY" ? code : "CONFIG_ERROR",
        message,
      );
    }
    if (error.code === "VALIDATION_ERROR") {
      return build(codeFromText(message) === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT", message);
    }
    if (error.code === "BINARY_MISSING") return build("BINARY_MISSING", message);
    if (error.code === "POLL_TIMEOUT") return build("TIMEOUT", message);
    if (error.code === "UNKNOWN_REMOTE_STATE") return build("UNKNOWN_REMOTE_STATE", message);
    if (error instanceof BudgetError) return build(error.code as ErrorCode, message);
  } else if (error instanceof Error && error.cause instanceof MultixError) {
    // A plain Error that adds context (a request id, a resume hint) to a typed error keeps
    // the typed error's code, HTTP status and Retry-After, and reports its own message.
    // A job the provider did not fail stays off JOB_FAILED, whatever the wrapper's text says.
    const info = classifyError(error.cause);
    if (info.code !== "UNKNOWN" || error.cause instanceof ProviderJobFailedError) {
      return { ...info, message: redactUrlsInText(message) };
    }
  }
  return classifyMessage(message);
}
