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
  /** Deadline for the whole job (downloads, CLI, uploads) in milliseconds. */
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

/**
 * Whole-job budget inside the container: downloads, the CLI and uploads share
 * this one deadline (container/job-runner.mjs).
 */
export const JOB_TIMEOUT_MS = 30 * 60_000;
/** The Durable Object gives up on a job that has not reported this long after it started. */
export const JOB_GIVE_UP_MS = JOB_TIMEOUT_MS + 5 * 60_000;
/**
 * A per-account job slot expires on its own after this long, so a job whose
 * Durable Object never released it (crash, lost RPC) cannot hold it forever.
 * Longer than JOB_GIVE_UP_MS, so a live job never loses its slot.
 */
export const JOB_SLOT_LEASE_MS = JOB_GIVE_UP_MS + 10 * 60_000;
/** Returned when every job container is in use (the `max_instances` limit). */
export const SERVER_AT_CAPACITY_ERROR =
  "server at capacity: every job container is in use; retry in a few minutes";
/** Job records (KV and Durable Object storage) are kept this long. */
export const JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
