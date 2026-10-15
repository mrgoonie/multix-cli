/**
 * One account's event subscriptions and webhook deliveries, kept free of the
 * Durable Object runtime so it can be unit-tested: AccountEvents
 * (account-events.ts) supplies the storage, fetch and clock.
 *
 * publish -> dedupe by event id -> one queued delivery per matching active
 * subscription -> the alarm sends due deliveries (signed, bounded batch) ->
 * success, retry with backoff, or a dead letter. A subscription whose
 * deliveries keep dead-lettering, or whose endpoint answers 410, is disabled.
 *
 * Storage keys (Durable Object storage, SQLite-backed):
 *   sub:<id>                   subscription, secret included (never returned after create)
 *   seen:<eventId>             when the event was first published (dedupe)
 *   q:<dueAt>:<deliveryId>     queued delivery, ordered by due time
 *   dead:<at>:<deliveryId>     dead letter (ids, reason, attempts; no payload)
 *   audit:<at>:<n>             audit log
 *   meta:housekept             last housekeeping run
 *
 * A subscription record is never held across a network call: it is read and
 * written back with nothing but storage calls in between, which a Durable
 * Object runs without letting another request in, so a revoke or a
 * concurrent delivery update is never overwritten.
 */

import { redactUrl } from "../../../src/core/redact.js";
import { randomBase64Url } from "../accounts/base64.js";
import { logEvent } from "../redaction.js";
import { type EventName, type MultixEvent, isEventName } from "./event-catalog.js";
import { generateWebhookSecret, signWebhook } from "./webhook-signing.js";

export const MAX_ACTIVE_SUBSCRIPTIONS = 10;
export const DEFAULT_SUBSCRIPTION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MIN_SUBSCRIPTION_TTL_SECONDS = 60 * 60;
export const MAX_SUBSCRIPTION_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Wait before retry n (1-based) of a failed delivery; the delivery is dead-lettered after the last. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** A `Retry-After` longer than this is capped. */
export const MAX_RETRY_AFTER_SECONDS = 3600;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Deliveries sent per alarm run; more due ones run on an immediate next alarm. */
export const DELIVERY_BATCH = 10;
/** Queued deliveries per account; past this, new deliveries go straight to dead letters. */
export const MAX_QUEUED_DELIVERIES = 500;
/** Dead letters in a row after which a subscription is disabled. */
export const DISABLE_AFTER_DEAD_LETTERS = 5;
/** Longer than the job retention (7 days), so a late relay of an old job is still deduped. */
export const SEEN_RETENTION_MS = 8 * 24 * 60 * 60_000;
export const RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_DEAD_LETTERS = 100;
export const MAX_AUDIT_ENTRIES = 200;
export const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60_000;
/** Largest signed body; job events are a few hundred bytes. */
export const MAX_EVENT_BYTES = 16 * 1024;

export type SubscriptionStatus = "active" | "disabled" | "expired";

export interface Subscription {
  id: string;
  callbackUrl: string;
  events: EventName[];
  secret: string;
  description?: string;
  status: SubscriptionStatus;
  statusReason?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  deliveredCount: number;
  consecutiveDeadLetters: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface QueuedDelivery {
  id: string;
  subscriptionId: string;
  event: MultixEvent;
  /** Attempts already made. */
  attempts: number;
  queuedAt: number;
  lastStatus?: number;
  lastError?: string;
}

export interface DeadLetter {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventName: string;
  attempts: number;
  reason: string;
  lastStatus?: number;
  at: number;
}

export interface AuditEntry {
  at: number;
  action: string;
  actor: string;
  subscriptionId?: string;
  detail?: string;
}

/** What callers see of a subscription: never the secret, and the callback's query is redacted. */
export interface SubscriptionView {
  id: string;
  callback_url: string;
  events: EventName[];
  description?: string;
  status: SubscriptionStatus;
  status_reason?: string;
  created_at: string;
  expires_at: string;
  delivered_count: number;
  consecutive_dead_letters: number;
  last_success_at?: string;
  last_failure_at?: string;
}

export interface SubscriptionInput {
  callbackUrl: string;
  events: EventName[];
  ttlSeconds: number;
  description?: string;
}

/** The subset of DurableObjectStorage the hub uses. */
export interface HubStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: {
    prefix: string;
    start?: string;
    end?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface HubPorts {
  storage: HubStorage;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now(): number;
}

/**
 * Result of subscribe. Failures are returned rather than thrown: errors lose
 * their class when they cross Durable Object RPC.
 */
export type SubscribeResult =
  | { ok: true; subscription: SubscriptionView; secret: string }
  | { ok: false; error: "limit_reached"; message: string };

const TIME_DIGITS = 15;
const pad = (ms: number) => String(Math.max(0, Math.floor(ms))).padStart(TIME_DIGITS, "0");
const queueKey = (dueAt: number, id: string) => `q:${pad(dueAt)}:${id}`;
const subKey = (id: string) => `sub:${id}`;
const iso = (ms: number) => new Date(ms).toISOString();

export function subscriptionView(sub: Subscription): SubscriptionView {
  const view: SubscriptionView = {
    id: sub.id,
    callback_url: redactUrl(sub.callbackUrl),
    events: sub.events,
    status: sub.status,
    created_at: iso(sub.createdAt),
    expires_at: iso(sub.expiresAt),
    delivered_count: sub.deliveredCount,
    consecutive_dead_letters: sub.consecutiveDeadLetters,
  };
  if (sub.description) view.description = sub.description;
  if (sub.statusReason) view.status_reason = sub.statusReason;
  if (sub.lastSuccessAt) view.last_success_at = iso(sub.lastSuccessAt);
  if (sub.lastFailureAt) view.last_failure_at = iso(sub.lastFailureAt);
  return view;
}

type Outcome =
  | { kind: "delivered"; status: number }
  | { kind: "retry"; status?: number; error: string; retryAfterSeconds?: number }
  | { kind: "permanent"; status?: number; error: string; gone?: boolean };

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function classify(response: Response): Outcome {
  const status = response.status;
  if (status >= 200 && status < 300) return { kind: "delivered", status };
  if (status === 410) {
    return { kind: "permanent", status, error: "endpoint answered 410 Gone", gone: true };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      kind: "retry",
      status,
      error: `endpoint answered ${status}`,
      retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
    };
  }
  if (status >= 300 && status < 400) {
    return { kind: "permanent", status, error: "endpoint redirected; redirects are not followed" };
  }
  return { kind: "permanent", status, error: `endpoint answered ${status}` };
}

export class EventHub {
  private auditSeq = 0;

  constructor(private readonly ports: HubPorts) {}

  private get storage(): HubStorage {
    return this.ports.storage;
  }

  // ---- subscriptions -------------------------------------------------------

  /** Create a subscription; the returned secret is not retrievable afterwards. */
  async subscribe(input: SubscriptionInput, actor: string): Promise<SubscribeResult> {
    const now = this.ports.now();
    const active = (await this.subscriptions()).filter((s) => this.isLive(s, now));
    if (active.length >= MAX_ACTIVE_SUBSCRIPTIONS) {
      return {
        ok: false,
        error: "limit_reached",
        message: `An account may have at most ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions; delete one first`,
      };
    }
    const sub: Subscription = {
      id: `sub_${randomBase64Url(12)}`,
      callbackUrl: input.callbackUrl,
      events: [...new Set(input.events)],
      secret: generateWebhookSecret(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + input.ttlSeconds * 1000,
      deliveredCount: 0,
      consecutiveDeadLetters: 0,
    };
    if (input.description) sub.description = input.description;
    await this.storage.put({ [subKey(sub.id)]: sub });
    await this.audit({ action: "subscription.created", actor, subscriptionId: sub.id });
    await this.ensureAlarm(now + HOUSEKEEPING_INTERVAL_MS);
    return { ok: true, subscription: subscriptionView(sub), secret: sub.secret };
  }

  async listSubscriptions(): Promise<SubscriptionView[]> {
    return (await this.subscriptions()).map(subscriptionView);
  }

  async getSubscription(id: string): Promise<SubscriptionView | null> {
    const sub = await this.storage.get<Subscription>(subKey(id));
    return sub ? subscriptionView(sub) : null;
  }

  /** Revoke: the subscription and its queued deliveries are removed at once. False when unknown. */
  async unsubscribe(id: string, actor: string): Promise<boolean> {
    const sub = await this.storage.get<Subscription>(subKey(id));
    if (!sub) return false;
    const queued = await this.storage.list<QueuedDelivery>({ prefix: "q:" });
    const keys = [subKey(id)];
    for (const [key, delivery] of queued) {
      if (delivery.subscriptionId === id) keys.push(key);
    }
    await this.storage.delete(keys);
    await this.audit({
      action: "subscription.revoked",
      actor,
      subscriptionId: id,
      detail: keys.length > 1 ? `${keys.length - 1} queued deliveries dropped` : undefined,
    });
    return true;
  }

  async deadLetters(limit = MAX_DEAD_LETTERS): Promise<DeadLetter[]> {
    const entries = await this.storage.list<DeadLetter>({ prefix: "dead:", reverse: true, limit });
    return [...entries.values()];
  }

  async auditLog(limit = MAX_AUDIT_ENTRIES): Promise<AuditEntry[]> {
    const entries = await this.storage.list<AuditEntry>({ prefix: "audit:", reverse: true, limit });
    return [...entries.values()];
  }

  // ---- publishing ----------------------------------------------------------

  /**
   * Accept events for this account. Each event is recorded as seen together
   * with its queued deliveries in one write, so a crash never leaves an event
   * marked seen without its deliveries; publishing an event again is a no-op.
   */
  async publish(events: readonly MultixEvent[]): Promise<{ accepted: number; duplicates: number }> {
    const now = this.ports.now();
    let accepted = 0;
    let duplicates = 0;
    let queued = (await this.storage.list({ prefix: "q:" })).size;
    for (const event of events) {
      if (!isEventName(event?.name) || typeof event.id !== "string" || !event.id) continue;
      if (await this.storage.get(`seen:${event.id}`)) {
        duplicates++;
        continue;
      }
      const subs = (await this.subscriptions()).filter(
        (s) => this.isLive(s, now) && s.events.includes(event.name),
      );
      const writes: Record<string, unknown> = { [`seen:${event.id}`]: now };
      const tooLarge = JSON.stringify(event).length > MAX_EVENT_BYTES;
      for (const sub of subs) {
        const delivery: QueuedDelivery = {
          id: `dlv_${randomBase64Url(12)}`,
          subscriptionId: sub.id,
          event,
          attempts: 0,
          queuedAt: now,
        };
        if (tooLarge || queued >= MAX_QUEUED_DELIVERIES) {
          const reason = tooLarge ? "event too large" : "delivery queue full";
          writes[`dead:${pad(now)}:${delivery.id}`] = this.deadLetter(delivery, reason, now);
          logEvent("warn", "event_delivery_dead_lettered", {
            event: event.name,
            subscription: sub.id,
            reason,
          });
          continue;
        }
        writes[queueKey(now, delivery.id)] = delivery;
        queued++;
      }
      await this.storage.put(writes);
      accepted++;
      logEvent("info", "event_published", { event: event.name, matched: subs.length });
    }
    if (queued > 0) await this.ensureAlarm(now);
    return { accepted, duplicates };
  }

  // ---- delivery ------------------------------------------------------------

  /** Alarm handler: send due deliveries, tidy up, and schedule the next run. */
  async alarm(): Promise<void> {
    const now = this.ports.now();
    const due = await this.storage.list<QueuedDelivery>({
      prefix: "q:",
      end: `q:${pad(now)};`,
      limit: DELIVERY_BATCH,
    });
    // One subscription's deliveries run in order (its record is updated after each);
    // different subscriptions run in parallel.
    const bySubscription = new Map<string, [string, QueuedDelivery][]>();
    for (const entry of due) {
      const list = bySubscription.get(entry[1].subscriptionId) ?? [];
      list.push(entry);
      bySubscription.set(entry[1].subscriptionId, list);
    }
    await Promise.all(
      [...bySubscription.values()].map(async (entries) => {
        for (const [key, delivery] of entries) await this.deliver(key, delivery);
      }),
    );
    if (due.size >= DELIVERY_BATCH) {
      await this.storage.setAlarm(this.ports.now());
      return;
    }
    await this.housekeep();
    await this.scheduleNext();
  }

  private async deliver(key: string, delivery: QueuedDelivery): Promise<void> {
    const before = await this.storage.get<Subscription>(subKey(delivery.subscriptionId));
    const now = this.ports.now();
    if (!before) {
      // Revoked after this delivery was queued.
      await this.storage.delete([key]);
      return;
    }
    if (!this.isLive(before, now)) {
      await this.deadLetterDelivery(key, delivery, `subscription ${before.status}`, now);
      return;
    }
    const outcome = await this.send(before, delivery, now);
    const attempts = delivery.attempts + 1;
    const after = this.ports.now();
    if (outcome.kind === "delivered") {
      await this.storage.delete([key]);
      await this.updateSubscription(delivery.subscriptionId, (sub) => {
        sub.deliveredCount++;
        sub.consecutiveDeadLetters = 0;
        sub.lastSuccessAt = after;
      });
      logEvent("info", "event_delivered", {
        event: delivery.event.name,
        subscription: delivery.subscriptionId,
        attempts,
        status: outcome.status,
      });
      return;
    }
    const failed = { ...delivery, attempts, lastStatus: outcome.status, lastError: outcome.error };
    if (outcome.kind === "retry" && attempts < MAX_DELIVERY_ATTEMPTS) {
      const backoff = RETRY_DELAYS_SECONDS[attempts - 1] ?? 0;
      const wait = Math.max(
        backoff,
        Math.min(outcome.retryAfterSeconds ?? 0, MAX_RETRY_AFTER_SECONDS),
      );
      // Write the retry before dropping the old entry: a crash in between repeats a
      // delivery (receivers dedupe on webhook-id) rather than losing one.
      await this.storage.put({ [queueKey(after + wait * 1000, delivery.id)]: failed });
      await this.storage.delete([key]);
      await this.updateSubscription(delivery.subscriptionId, (sub) => {
        sub.lastFailureAt = after;
      });
      logEvent("warn", "event_delivery_retry", {
        event: delivery.event.name,
        subscription: delivery.subscriptionId,
        attempts,
        status: outcome.status,
        retry_in_seconds: wait,
      });
      return;
    }
    const reason =
      outcome.kind === "retry"
        ? `gave up after ${attempts} attempts: ${outcome.error}`
        : outcome.error;
    await this.deadLetterDelivery(
      key,
      failed,
      reason,
      after,
      outcome.kind === "permanent" && outcome.gone,
    );
  }

  private async send(sub: Subscription, delivery: QueuedDelivery, now: number): Promise<Outcome> {
    const body = JSON.stringify(delivery.event);
    const timestamp = Math.floor(now / 1000);
    try {
      const signature = await signWebhook(sub.secret, delivery.event.id, timestamp, body);
      const response = await this.ports.fetch(sub.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "multix-events/1",
          "webhook-id": delivery.event.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return classify(response);
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      return { kind: "retry", error: timedOut ? "endpoint timed out" : "endpoint unreachable" };
    }
  }

  private deadLetter(delivery: QueuedDelivery, reason: string, at: number): DeadLetter {
    const entry: DeadLetter = {
      id: delivery.id,
      subscriptionId: delivery.subscriptionId,
      eventId: delivery.event.id,
      eventName: delivery.event.name,
      attempts: delivery.attempts,
      reason,
      at,
    };
    if (delivery.lastStatus !== undefined) entry.lastStatus = delivery.lastStatus;
    return entry;
  }

  private async deadLetterDelivery(
    key: string,
    delivery: QueuedDelivery,
    reason: string,
    at: number,
    gone = false,
  ): Promise<void> {
    await this.storage.put({
      [`dead:${pad(at)}:${delivery.id}`]: this.deadLetter(delivery, reason, at),
    });
    await this.storage.delete([key]);
    logEvent("warn", "event_delivery_dead_lettered", {
      event: delivery.event.name,
      subscription: delivery.subscriptionId,
      attempts: delivery.attempts,
      status: delivery.lastStatus,
    });
    let disabled: string | undefined;
    await this.updateSubscription(delivery.subscriptionId, (sub) => {
      if (sub.status !== "active") return;
      sub.lastFailureAt = at;
      sub.consecutiveDeadLetters++;
      if (gone) disabled = "the endpoint answered 410 Gone";
      else if (sub.consecutiveDeadLetters >= DISABLE_AFTER_DEAD_LETTERS) {
        disabled = `${sub.consecutiveDeadLetters} deliveries in a row failed`;
      }
      if (disabled) {
        sub.status = "disabled";
        sub.statusReason = disabled;
      }
    });
    if (disabled) {
      await this.audit({
        action: "subscription.disabled",
        actor: "system",
        subscriptionId: delivery.subscriptionId,
        detail: disabled,
      });
    }
  }

  // ---- housekeeping --------------------------------------------------------

  /** Expire subscriptions and trim dedupe records, dead letters and the audit log. */
  private async housekeep(): Promise<void> {
    const now = this.ports.now();
    const last = (await this.storage.get<number>("meta:housekept")) ?? 0;
    if (now - last < HOUSEKEEPING_INTERVAL_MS) return;
    const drop: string[] = [];
    for (const sub of await this.subscriptions()) {
      if (sub.status === "active" && sub.expiresAt <= now) {
        await this.updateSubscription(sub.id, (s) => {
          s.status = "expired";
          s.statusReason = "the subscription reached its expiry time";
        });
        await this.audit({
          action: "subscription.expired",
          actor: "system",
          subscriptionId: sub.id,
        });
      } else if (sub.status !== "active" && now - sub.updatedAt > RECORD_RETENTION_MS) {
        drop.push(subKey(sub.id));
      }
    }
    for (const [key, at] of await this.storage.list<number>({ prefix: "seen:" })) {
      if (now - at > SEEN_RETENTION_MS) drop.push(key);
    }
    drop.push(...(await this.overflow("dead:", MAX_DEAD_LETTERS, now)));
    drop.push(...(await this.overflow("audit:", MAX_AUDIT_ENTRIES, now)));
    // DurableObjectStorage.delete takes at most 128 keys per call.
    for (let i = 0; i < drop.length; i += 128) await this.storage.delete(drop.slice(i, i + 128));
    await this.storage.put({ "meta:housekept": now });
  }

  /** Keys under a time-ordered prefix past the count limit or the retention period. */
  private async overflow(prefix: string, max: number, now: number): Promise<string[]> {
    const keys = [...(await this.storage.list({ prefix, reverse: true })).keys()];
    return keys.filter((key, index) => {
      const at = Number(key.slice(prefix.length, prefix.length + TIME_DIGITS));
      return index >= max || now - at > RECORD_RETENTION_MS;
    });
  }

  private async scheduleNext(): Promise<void> {
    const next = await this.storage.list<QueuedDelivery>({ prefix: "q:", limit: 1 });
    const [key] = next.keys();
    if (key) {
      await this.storage.setAlarm(Number(key.slice(2, 2 + TIME_DIGITS)));
      return;
    }
    const hasState =
      (await this.storage.list({ prefix: "sub:", limit: 1 })).size > 0 ||
      (await this.storage.list({ prefix: "seen:", limit: 1 })).size > 0;
    if (hasState) await this.storage.setAlarm(this.ports.now() + HOUSEKEEPING_INTERVAL_MS);
  }

  /** Make sure an alarm fires no later than `at`. */
  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
  }

  // ---- helpers -------------------------------------------------------------

  private isLive(sub: Subscription, now: number): boolean {
    return sub.status === "active" && sub.expiresAt > now;
  }

  private async subscriptions(): Promise<Subscription[]> {
    return [...(await this.storage.list<Subscription>({ prefix: "sub:" })).values()];
  }

  /** Read, change and write back one subscription with nothing but storage calls in between. */
  private async updateSubscription(id: string, change: (sub: Subscription) => void): Promise<void> {
    const sub = await this.storage.get<Subscription>(subKey(id));
    if (!sub) return;
    change(sub);
    sub.updatedAt = this.ports.now();
    await this.storage.put({ [subKey(id)]: sub });
  }

  private async audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    const at = this.ports.now();
    const record: AuditEntry = { at, ...entry };
    const n = String(this.auditSeq++ % 1_000_000).padStart(6, "0");
    await this.storage.put({ [`audit:${pad(at)}:${n}${randomBase64Url(3)}`]: record });
  }
}
