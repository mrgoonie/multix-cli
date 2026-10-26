/**
 * Outbox of the job Durable Object. The final job view and its events are
 * written in one storage write (jobs/multix-job-container.ts), so a job that
 * reached a final state always has its events stored, even if the object is
 * reset right after. A scheduled relay then hands them to the owner's
 * AccountEvents object and deletes them only once it has accepted them;
 * a failed hand-over is retried with a growing delay, up to hourly, for as
 * long as the job's data is kept. AccountEvents dedupes
 * by event id, so a relay repeated after a crash is harmless.
 */

import { JOB_RETENTION_SECONDS } from "../jobs/job-protocol.js";
import { logEvent } from "../redaction.js";
import type { MultixEvent } from "./event-catalog.js";

export const OUTBOX_PREFIX = "outbox:";
const RELAY_BASE_SECONDS = 10;
const RELAY_MAX_SECONDS = 3600;
/** Hourly retries after the first few cover the job's whole retention period. */
export const RELAY_ATTEMPTS = Math.ceil(JOB_RETENTION_SECONDS / RELAY_MAX_SECONDS) + 10;

export function outboxKey(eventId: string): string {
  return `${OUTBOX_PREFIX}${eventId}`;
}

/** Wait before relay attempt `attempt` (2-based): 10 s, 20 s, 40 s … capped at an hour. */
export function relayDelaySeconds(attempt: number): number {
  return Math.min(RELAY_BASE_SECONDS * 2 ** Math.max(0, attempt - 2), RELAY_MAX_SECONDS);
}

export interface OutboxPort<T = MultixEvent> {
  list(): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<void>;
  /** Hand entries to the owner's Durable Object; undefined when it is not configured. */
  publish: ((entries: T[]) => Promise<unknown>) | undefined;
  scheduleRelay(attempt: number, seconds: number): Promise<void>;
  /** Log name prefix, `event` (default) or `ledger`. */
  label?: string;
}

/** Also relays the job's usage-ledger record (ledger/ledger-records.ts) the same way. */
export async function relayOutbox<T>(port: OutboxPort<T>, attempt = 1): Promise<void> {
  const label = port.label ?? "event";
  try {
    const entries = await port.list();
    if (entries.size === 0 || !port.publish) return;
    await port.publish([...entries.values()]);
    await port.delete([...entries.keys()]);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    if (attempt >= RELAY_ATTEMPTS) {
      // The entries stay until the job's data expires; nothing else retries them.
      logEvent("error", `${label}_relay_gave_up`, { attempt, error: name });
      return;
    }
    logEvent("warn", `${label}_relay_failed`, { attempt, error: name });
    try {
      await port.scheduleRelay(attempt + 1, relayDelaySeconds(attempt + 1));
    } catch {
      logEvent("error", `${label}_relay_unscheduled`, { attempt });
    }
  }
}
