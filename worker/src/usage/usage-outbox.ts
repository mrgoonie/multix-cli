/**
 * Usage record of a finished remote job, kept in the job Durable Object's
 * outbox (next to its lifecycle events) until the owner's AccountUsage has
 * accepted it. Written in the same storage write as the final job view, so a
 * finished job always reaches the ledger; the ledger ignores a replay
 * (settle is keyed by job id).
 *
 * The record carries counts, timings, fixed error wording and the CLI's
 * redacted run summary. Output URLs are reduced to "stored or not".
 */

import { RELAY_ATTEMPTS, relayDelaySeconds } from "../events/event-outbox.js";
import type { JobView } from "../jobs/job-protocol.js";
import { isTerminal } from "../jobs/job-protocol.js";
import { logEvent } from "../redaction.js";
import type { SettleInput } from "./usage-types.js";

export const USAGE_OUTBOX_KEY = "usage:settle";

export interface UsageOutboxRecord {
  userId: string;
  input: SettleInput;
}

/** The ledger's view of a finished job; undefined while it is still running. */
export function settleInputFor(jobId: string, view: JobView): SettleInput | undefined {
  if (!isTerminal(view.status)) return undefined;
  const result = view.result;
  const input: SettleInput = {
    jobId,
    status: view.status,
    createdAt: view.createdAt,
    finishedAt: view.finishedAt ?? view.createdAt,
    exitCode: result?.exitCode ?? null,
    outputs: (result?.outputs ?? []).map((o) => ({
      name: o.name,
      bytes: o.bytes,
      stored: o.url !== null,
    })),
  };
  if (view.runningAt !== undefined) input.runningAt = view.runningAt;
  const error = view.error ?? result?.error;
  if (error) input.error = error;
  if (result?.timings) input.timings = result.timings;
  if (result?.run) input.run = result.run;
  if (result?.stderrTail) input.stderrTail = result.stderrTail;
  return input;
}

export interface UsageOutboxPort {
  load(): Promise<UsageOutboxRecord | undefined>;
  remove(): Promise<void>;
  /** Hand the record to the owner's AccountUsage; undefined when the ledger is not configured. */
  settle: ((record: UsageOutboxRecord) => Promise<unknown>) | undefined;
  scheduleRelay(attempt: number, seconds: number): Promise<void>;
}

/** Same retry schedule as the event outbox: growing delay, up to hourly, for the job's retention. */
export async function relayUsage(port: UsageOutboxPort, attempt = 1): Promise<void> {
  try {
    const record = await port.load();
    if (!record || !port.settle) return;
    await port.settle(record);
    await port.remove();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    if (attempt >= RELAY_ATTEMPTS) {
      logEvent("error", "usage_relay_gave_up", { attempt, error: name });
      return;
    }
    logEvent("warn", "usage_relay_failed", { attempt, error: name });
    try {
      await port.scheduleRelay(attempt + 1, relayDelaySeconds(attempt + 1));
    } catch {
      logEvent("error", "usage_relay_unscheduled", { attempt });
    }
  }
}
