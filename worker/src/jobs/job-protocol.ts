/**
 * Messages between the Worker, the job Durable Object and the job server in
 * the container (container/job-server.mjs mirrors these shapes in plain JS).
 * Secrets travel only in `JobSpec` (POST body to the container); nothing that
 * holds them is ever stored or logged.
 */

import type { R2Settings } from "../accounts/r2-settings.js";

export interface JobInputFile {
  /** Public https URL to download. */
  url: string;
  /** Relative path inside the job directory, always under `in/`. */
  path: string;
}

export interface JobSpec {
  jobId: string;
  /** Arguments after `multix`, built and validated by the Worker. */
  argv: string[];
  /** Provider key env vars for the child process (the caller's own keys). */
  env: Record<string, string>;
  inputs: JobInputFile[];
  /** Where to upload outputs; absent when the account has no R2 bucket configured. */
  upload?: { r2: R2Settings; keyPrefix: string };
  /** Kill the CLI after this many milliseconds. */
  timeoutMs: number;
}

export type JobTerminalStatus = "succeeded" | "failed" | "timed_out" | "canceled";
export type JobStatus = "starting" | "running" | JobTerminalStatus;

export interface JobOutput {
  /** File name relative to the job's output directory. */
  name: string;
  /** Public or presigned (7-day) R2 URL; null when the file was not uploaded. */
  url: string | null;
  bytes: number;
}

/** Final report from the job server. stdout/stderr are truncated and redacted. */
export interface JobResult {
  status: JobTerminalStatus;
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  outputs: JobOutput[];
  /** Short explanation for a failure outside the CLI (download, upload, timeout). */
  error?: string;
  note?: string;
}

/** What the Durable Object reports about its job. */
export interface JobView {
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  result?: JobResult;
  error?: string;
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
]);

export function isTerminal(status: JobStatus): status is JobTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

/** How long the CLI may run inside the container. */
export const JOB_TIMEOUT_MS = 30 * 60_000;
/** Job records (KV and Durable Object storage) are kept this long. */
export const JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
