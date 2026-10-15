/**
 * Outbox of the job Durable Object. The final job view and its events are
 * written in one storage write (jobs/multix-job-container.ts), so a job that
 * reached a final state always has its events stored, even if the object is
 * reset right after. A scheduled relay then hands them to the owner's
 * AccountEvents object and deletes them only once it has accepted them;
 * a failed hand-over is retried with a growing delay. AccountEvents dedupes
 * by event id, so a relay repeated after a crash is harmless.
 */

import { logEvent } from "../redaction.js";
import type { MultixEvent } from "./event-catalog.js";

export const OUTBOX_PREFIX = "outbox:";
export const RELAY_ATTEMPTS = 10;
const RELAY_BASE_SECONDS = 10;
const RELAY_MAX_SECONDS = 3600;

export function outboxKey(eventId: string): string {
  return `${OUTBOX_PREFIX}${eventId}`;
}

/** Wait before relay attempt `attempt` (2-based): 10 s, 20 s, 40 s … capped at an hour. */
export function relayDelaySeconds(attempt: number): number {
  return Math.min(RELAY_BASE_SECONDS * 2 ** Math.max(0, attempt - 2), RELAY_MAX_SECONDS);
}

export interface OutboxPort {
  list(): Promise<Map<string, MultixEvent>>;
  delete(keys: string[]): Promise<void>;
  /** Hand events to the owner's AccountEvents; undefined when events are not configured. */
  publish: ((events: MultixEvent[]) => Promise<unknown>) | undefined;
  scheduleRelay(attempt: number, seconds: number): Promise<void>;
}

export async function relayOutbox(port: OutboxPort, attempt = 1): Promise<void> {
  const entries = await port.list();
  if (entries.size === 0 || !port.publish) return;
  try {
    await port.publish([...entries.values()]);
    await port.delete([...entries.keys()]);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    if (attempt >= RELAY_ATTEMPTS) {
      // The entries stay until the job's data expires; nothing else retries them.
      logEvent("error", "event_relay_gave_up", { attempt, events: entries.size, error: name });
      return;
    }
    logEvent("warn", "event_relay_failed", { attempt, error: name });
    try {
      await port.scheduleRelay(attempt + 1, relayDelaySeconds(attempt + 1));
    } catch {
      logEvent("error", "event_relay_unscheduled", { attempt });
    }
  }
}
