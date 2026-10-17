/**
 * One account's event subscriptions and webhook deliveries, kept free of the
 * Durable Object runtime so it can be unit-tested: AccountEvents
 * (account-events.ts) supplies the storage, fetch, callback check and clock.
 *
 * publish -> dedupe by event id -> one queued delivery per matching active
 * subscription -> the alarm sends due deliveries (signed, bounded batch) ->
 * success, retry with backoff, or a dead letter. Right before each attempt
 * the callback host is resolved again and must still be public (DNS
 * rebinding); a host that is not is retried like an unreachable endpoint. A subscription whose
 * deliveries keep dead-lettering, or whose endpoint answers 410, is disabled.
 *
 * Storage keys (Durable Object storage, SQLite-backed):
 *   sub:<id>                   subscription, secret included (never returned after create)
 *   seen:<eventId>             when the event was first published (dedupe)
 *   q:<dueAt>:<deliveryId>     queued delivery, ordered by due time
 *   dead:<at>:<deliveryId>     dead letter (ids, reason, attempts; no payload)
 *   audit:<at>:<n>             audit log
 *   revoked:<clientId>         when an OAuth client's subscriptions were removed (fence)
 *   meta:housekept             last housekeeping run
 *
 * Subscriptions made over MCP Events (`events/subscribe`) carry an `mcp`
 * record: the client chose the secret and the id is derived from the
 * subscription's identity, so subscribing again refreshes it. Their
 * deliveries use the MCP Events body and headers and may be narrowed to one
 * job.
 *
 * A subscription record is never held across a network call: it is read and
 * written back with nothing but storage calls in between, which a Durable
 * Object runs without letting another request in, so a revoke or a
 * concurrent delivery update is never overwritten.
 */

import { redactUrl } from "../../../src/core/redact.js";
import { randomBase64Url } from "../accounts/base64.js";
import { logEvent } from "../redaction.js";
import { CallbackDnsError, CallbackUrlError } from "./callback-guard.js";
import { type EventName, type MultixEvent, isEventName } from "./event-catalog.js";
import { generateWebhookSecret, signWebhook } from "./webhook-signing.js";

export const MAX_ACTIVE_SUBSCRIPTIONS = 10;
export const DEFAULT_SUBSCRIPTION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MIN_SUBSCRIPTION_TTL_SECONDS = 60 * 60;
export const MAX_SUBSCRIPTION_TTL_SECONDS = 90 * 24 * 60 * 60;
/** After an MCP refresh changes the secret, deliveries are signed with both for this long. */
export const MCP_SECRET_ROTATION_MS = 60 * 60_000;
/**
 * After a client's subscriptions are removed (its connection was revoked), the
 * client may not create or refresh one for this long. Covers a subscribe that
 * was verifying its callback during the revoke, and a revoked token still
 * accepted from an edge cache (about a minute).
 */
export const REVOKED_CLIENT_FENCE_MS = 10 * 60_000;
/** MCP subscriptions are only revived by subscribing again, so expired ones go sooner. */
export const MCP_RECORD_RETENTION_MS = 24 * 60 * 60_000;
/** Wait before retry n (1-based) of a failed delivery; the delivery is dead-lettered after the last. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
/** A `Retry-After` longer than this is capped. */
export const MAX_RETRY_AFTER_SECONDS = 3600;
export const DELIVERY_TIMEOUT_MS = 10_000;
/**
 * Deliveries sent per alarm run; more due ones run on an immediate next alarm.
 * Each costs three subrequests (DNS A, DNS AAAA, POST): mind the per-invocation limit.
 */
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
/** Durable Object storage limit on keys per get/put/delete call. */
const MAX_KEYS_PER_CALL = 128;
/** Page size of the dedupe-record scan during housekeeping. */
const SCAN_PAGE = 1000;

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
  /** Present on subscriptions made over MCP Events. */
  mcp?: McpSubscriptionFields;
}

export interface McpSubscriptionFields {
  /** Only events about this job; every job of the account when omitted. */
  jobId?: string;
  /** The secret the last refresh replaced, still signed with until `until`. */
  previousSecret?: { secret: string; until: number };
  /** OAuth client that created or last refreshed the subscription. */
  clientId?: string;
}

/** An MCP `events/subscribe` call after the Worker validated and verified it. */
export interface McpSubscriptionInput {
  /** Derived from (account, callback, event, arguments), see subscription-identity.ts. */
  id: string;
  callbackUrl: string;
  event: EventName;
  jobId?: string;
  /** Chosen by the client (`whsec_`, 24-64 bytes). */
  secret: string;
  ttlMs: number;
  clientId?: string;
  /**
   * The callback was not verified for this call because mcpSubscriptionState
   * reported it verified: the upsert then refuses unless that still holds.
   */
  reusesVerification?: boolean;
}

export type McpUpsertResult =
  | { ok: true; created: boolean; expiresAt: number }
  | {
      ok: false;
      error: "limit_reached" | "client_revoked" | "needs_verification";
      message: string;
    };

export interface McpSubscriptionState {
  /** A live subscription with this id, callback and secret exists: a refresh needs no new verification. */
  verified: boolean;
  /** Creating (or reviving) this subscription would exceed the account's limit. */
  atLimit: boolean;
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
  /** "mcp" on subscriptions made over MCP Events (`events/subscribe`). */
  source?: "mcp";
  /** MCP subscriptions narrowed to one job: only that job's events are delivered. */
  job_id?: string;
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
  /**
   * Resolve the callback host and throw unless every address is public
   * (callback-guard.ts `assertPublicCallbackUrl`). Runs before every attempt.
   */
  checkCallback(url: string): Promise<unknown>;
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
const revokedKey = (clientId: string) => `revoked:${clientId}`;
const iso = (ms: number) => new Date(ms).toISOString();

function limitReached(): { ok: false; error: "limit_reached"; message: string } {
  return {
    ok: false,
    error: "limit_reached",
    message: `An account may have at most ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions; delete one first`,
  };
}

/** The MCP Events delivery body: the subscription id travels in `X-MCP-Subscription-Id`. */
function mcpDeliveryBody(event: MultixEvent) {
  return {
    eventId: event.id,
    name: event.name,
    timestamp: event.occurred_at,
    data: event.data,
    cursor: null,
  };
}

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
  if (sub.mcp) {
    view.source = "mcp";
    if (sub.mcp.jobId !== undefined) view.job_id = sub.mcp.jobId;
  }
  return view;
}

type Outcome =
  | { kind: "delivered"; status: number }
  | {
      kind: "retry";
      status?: number;
      error: string;
      retryAfterSeconds?: number;
      /** Our own address check failed, not the endpoint: the attempt is not counted. */
      uncounted?: boolean;
    }
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
    if (active.length >= MAX_ACTIVE_SUBSCRIPTIONS) return limitReached();
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

  /** What an MCP subscribe needs to know before it verifies the callback. */
  async mcpSubscriptionState(
    id: string,
    callbackUrl: string,
    secret: string,
  ): Promise<McpSubscriptionState> {
    const now = this.ports.now();
    const existing = await this.storage.get<Subscription>(subKey(id));
    const live = existing?.mcp !== undefined && this.isLive(existing, now);
    return {
      verified: live && existing?.callbackUrl === callbackUrl && existing.secret === secret,
      atLimit: !live && (await this.liveCount(now)) >= MAX_ACTIVE_SUBSCRIPTIONS,
    };
  }

  /**
   * Create or refresh an MCP subscription. A refresh keeps the id, counters
   * and creation time, extends the lifetime, and keeps signing with a
   * replaced secret for MCP_SECRET_ROTATION_MS.
   */
  async upsertMcpSubscription(
    input: McpSubscriptionInput,
    actor: string,
  ): Promise<McpUpsertResult> {
    const now = this.ports.now();
    // REST ids (`sub_` + 16 base64url characters) never take the derived MCP form (24 hex).
    if (input.clientId) {
      const revokedAt = await this.storage.get<number>(revokedKey(input.clientId));
      if (revokedAt !== undefined && now - revokedAt < REVOKED_CLIENT_FENCE_MS) {
        return {
          ok: false,
          error: "client_revoked",
          message: "This client's connection was revoked; sign in again and retry later",
        };
      }
    }
    const existing = await this.storage.get<Subscription>(subKey(input.id));
    const live = existing !== undefined && this.isLive(existing, now);
    if (
      input.reusesVerification &&
      !(live && existing?.callbackUrl === input.callbackUrl && existing.secret === input.secret)
    ) {
      return {
        ok: false,
        error: "needs_verification",
        message: "The subscription changed; verify the callback again",
      };
    }
    if (!live && (await this.liveCount(now)) >= MAX_ACTIVE_SUBSCRIPTIONS) return limitReached();
    let previousSecret = existing?.mcp?.previousSecret;
    if (previousSecret && previousSecret.until <= now) previousSecret = undefined;
    if (existing && existing.secret !== input.secret) {
      previousSecret = { secret: existing.secret, until: now + MCP_SECRET_ROTATION_MS };
    }
    const mcp: McpSubscriptionFields = {};
    if (input.jobId !== undefined) mcp.jobId = input.jobId;
    if (previousSecret) mcp.previousSecret = previousSecret;
    if (input.clientId) mcp.clientId = input.clientId;
    const sub: Subscription = {
      id: input.id,
      callbackUrl: input.callbackUrl,
      events: [input.event],
      secret: input.secret,
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + input.ttlMs,
      deliveredCount: existing?.deliveredCount ?? 0,
      consecutiveDeadLetters: live ? (existing?.consecutiveDeadLetters ?? 0) : 0,
      mcp,
    };
    if (existing?.lastSuccessAt) sub.lastSuccessAt = existing.lastSuccessAt;
    if (existing?.lastFailureAt) sub.lastFailureAt = existing.lastFailureAt;
    await this.storage.put({ [subKey(sub.id)]: sub });
    await this.audit({
      action: existing ? "subscription.refreshed" : "subscription.created",
      actor,
      subscriptionId: sub.id,
    });
    await this.ensureAlarm(now + HOUSEKEEPING_INTERVAL_MS);
    return { ok: true, created: !existing, expiresAt: sub.expiresAt };
  }

  /**
   * Revoke every MCP subscription created or last refreshed by `clientId`;
   * returns how many. The client is fenced first (REVOKED_CLIENT_FENCE_MS), so
   * a subscribe still in flight cannot bring one back.
   */
  async removeByClient(clientId: string, actor: string): Promise<number> {
    const now = this.ports.now();
    await this.storage.put({ [revokedKey(clientId)]: now });
    await this.ensureAlarm(now + HOUSEKEEPING_INTERVAL_MS);
    let removed = 0;
    for (const sub of await this.subscriptions()) {
      if (sub.mcp?.clientId === clientId && (await this.unsubscribe(sub.id, actor))) removed++;
    }
    return removed;
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
    // The subscription goes first: deliveries still queued for it are dropped by
    // the alarm too, so revoke holds even if removing them below is cut short.
    await this.storage.delete([subKey(id)]);
    const queued = await this.storage.list<QueuedDelivery>({ prefix: "q:" });
    const keys: string[] = [];
    for (const [key, delivery] of queued) {
      if (delivery.subscriptionId === id) keys.push(key);
    }
    await this.deleteKeys(keys);
    await this.audit({
      action: "subscription.revoked",
      actor,
      subscriptionId: id,
      detail: keys.length > 0 ? `${keys.length} queued deliveries dropped` : undefined,
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
   * An event no live subscription wants leaves nothing behind.
   */
  async publish(events: readonly MultixEvent[]): Promise<{ accepted: number; duplicates: number }> {
    const now = this.ports.now();
    let accepted = 0;
    let duplicates = 0;
    let queued = (await this.storage.list({ prefix: "q:" })).size;
    let stored = false;
    for (const event of events) {
      if (!isEventName(event?.name) || typeof event.id !== "string" || !event.id) continue;
      if (await this.storage.get(`seen:${event.id}`)) {
        duplicates++;
        continue;
      }
      const subs = (await this.subscriptions()).filter(
        (s) =>
          this.isLive(s, now) &&
          s.events.includes(event.name) &&
          (s.mcp?.jobId === undefined || s.mcp.jobId === event.resource.id),
      );
      accepted++;
      if (subs.length === 0) continue;
      const writes: Record<string, unknown> = { [`seen:${event.id}`]: now };
      const tooLarge = new TextEncoder().encode(JSON.stringify(event)).length > MAX_EVENT_BYTES;
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
      stored = true;
      logEvent("info", "event_published", { event: event.name, matched: subs.length });
    }
    // Queued deliveries go out now; dedupe records and dead letters still need housekeeping.
    if (queued > 0) await this.ensureAlarm(now);
    else if (stored) await this.ensureAlarm(now + HOUSEKEEPING_INTERVAL_MS);
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
    // Housekeeping runs at most every few hours, so a backlog does not starve it.
    await this.housekeep();
    if (due.size >= DELIVERY_BATCH) {
      await this.storage.setAlarm(this.ports.now());
      return;
    }
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
      const status = before.status === "active" ? "expired" : before.status;
      await this.deadLetterDelivery(key, delivery, `subscription ${status}`, now);
      return;
    }
    const outcome = await this.send(before, delivery, now);
    const attempts = delivery.attempts + (outcome.kind === "retry" && outcome.uncounted ? 0 : 1);
    const after = this.ports.now();
    if (!(await this.storage.get(subKey(delivery.subscriptionId)))) {
      // Revoked while the request was in flight: keep no retry or dead letter for it.
      await this.storage.delete([key]);
      return;
    }
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
      const backoff = RETRY_DELAYS_SECONDS[Math.max(attempts, 1) - 1] ?? 0;
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
    try {
      await this.ports.checkCallback(sub.callbackUrl);
    } catch (error) {
      if (error instanceof CallbackUrlError) {
        if (error.reason === "invalid") {
          return { kind: "permanent", error: "endpoint URL is no longer allowed" };
        }
        return {
          kind: "retry",
          error:
            error.reason === "unresolved"
              ? "endpoint host could not be resolved"
              : "endpoint address not public",
        };
      }
      // DNS-over-HTTPS failed (or the check broke): our fault, so it costs no attempt.
      if (!(error instanceof CallbackDnsError)) {
        logEvent("error", "event_callback_check_failed", {
          subscription: sub.id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      return { kind: "retry", error: "callback address check unavailable", uncounted: true };
    }
    const body = JSON.stringify(sub.mcp ? mcpDeliveryBody(delivery.event) : delivery.event);
    const timestamp = Math.floor(now / 1000);
    const previous = sub.mcp?.previousSecret;
    const secrets = previous && previous.until > now ? [sub.secret, previous.secret] : [sub.secret];
    try {
      const signatures = await Promise.all(
        secrets.map((secret) => signWebhook(secret, delivery.event.id, timestamp, body)),
      );
      const response = await this.ports.fetch(sub.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "multix-events/1",
          "webhook-id": delivery.event.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signatures.join(" "),
          ...(sub.mcp ? { "x-mcp-subscription-id": sub.id } : {}),
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
      if (!this.isLive(sub, at)) return;
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
      } else if (
        sub.status !== "active" &&
        now - sub.updatedAt > (sub.mcp ? MCP_RECORD_RETENTION_MS : RECORD_RETENTION_MS)
      ) {
        drop.push(subKey(sub.id));
      }
    }
    for (const [key, at] of await this.storage.list<number>({ prefix: "revoked:" })) {
      if (now - at >= REVOKED_CLIENT_FENCE_MS) drop.push(key);
    }
    let start: string | undefined;
    for (;;) {
      const page = await this.storage.list<number>({ prefix: "seen:", start, limit: SCAN_PAGE });
      for (const [key, at] of page) if (now - at > SEEN_RETENTION_MS) drop.push(key);
      const last = [...page.keys()].at(-1);
      if (page.size < SCAN_PAGE || last === undefined) break;
      start = `${last}\0`;
    }
    drop.push(...(await this.overflow("dead:", MAX_DEAD_LETTERS, now)));
    drop.push(...(await this.overflow("audit:", MAX_AUDIT_ENTRIES, now)));
    await this.deleteKeys(drop);
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
      (await this.storage.list({ prefix: "revoked:", limit: 1 })).size > 0 ||
      (await this.storage.list({ prefix: "seen:", limit: 1 })).size > 0;
    if (hasState) await this.storage.setAlarm(this.ports.now() + HOUSEKEEPING_INTERVAL_MS);
  }

  /** Make sure an alarm fires no later than `at`. */
  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || current > at) await this.storage.setAlarm(at);
  }

  // ---- helpers -------------------------------------------------------------

  private async liveCount(now: number): Promise<number> {
    return (await this.subscriptions()).filter((s) => this.isLive(s, now)).length;
  }

  private isLive(sub: Subscription, now: number): boolean {
    return sub.status === "active" && sub.expiresAt > now;
  }

  /** DurableObjectStorage.delete takes at most 128 keys per call. */
  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
      await this.storage.delete(keys.slice(i, i + MAX_KEYS_PER_CALL));
    }
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
