/**
 * Persisted MCP Events subscriptions: one small Durable Object per account
 * (`MULTIX_EVENT_SUBSCRIPTIONS.getByName(userId)`), so an account's
 * subscriptions are strongly consistent, never shared with another account,
 * and survive Worker restarts. Request-scoped MCP servers only read and write
 * them through this object.
 *
 * Signing secrets are stored AES-GCM encrypted by the Worker (the object only
 * holds ciphertext). Expired subscriptions are dropped on every write and
 * never returned.
 */

import { DurableObject } from "cloudflare:workers";
import type { EncryptedValue } from "../accounts/provider-secret-crypto.js";

/** Subscriptions one account may hold at once. */
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;

export interface StoredSubscription {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  /** The current `whsec_` secret, encrypted. */
  secret: EncryptedValue;
  /** The secret replaced by the last refresh, still signed with until `until` (rotation window). */
  previousSecret?: { secret: EncryptedValue; until: number };
  /** OAuth client that created or last refreshed the subscription, when known. */
  clientId?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms after which the subscription is gone unless refreshed. */
  expiresAt: number;
}

/** The subset of Durable Object storage the store uses (in-memory in tests). */
export interface SubscriptionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export type UpsertResult = "created" | "updated" | "limit";

/** RPC surface of EventSubscriptions. */
export interface EventSubscriptionsStub {
  upsert(record: StoredSubscription, now: number): Promise<UpsertResult>;
  get(id: string, now: number): Promise<StoredSubscription | null>;
  remove(id: string): Promise<boolean>;
  list(now: number): Promise<StoredSubscription[]>;
  verifiedUntil(key: string): Promise<number>;
  /** Remember a passed verification until `until`; drops lapsed entries. */
  markVerified(key: string, until: number, now: number): Promise<void>;
}

export interface EventSubscriptionsNamespace {
  getByName(name: string): EventSubscriptionsStub;
}

const SUB_PREFIX = "sub:";
const VERIFIED_PREFIX = "verified:";

/** Store logic over plain key-value storage; the Durable Object below delegates to it. */
export function subscriptionStore(storage: SubscriptionStorage): EventSubscriptionsStub {
  async function live(now: number): Promise<Map<string, StoredSubscription>> {
    const all = await storage.list<StoredSubscription>({ prefix: SUB_PREFIX });
    const out = new Map<string, StoredSubscription>();
    for (const [key, sub] of all) {
      if (sub.expiresAt > now) out.set(key, sub);
      else await storage.delete(key);
    }
    return out;
  }

  return {
    async upsert(record, now) {
      const subs = await live(now);
      const key = `${SUB_PREFIX}${record.id}`;
      const existing = subs.get(key);
      if (!existing && subs.size >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) return "limit";
      await storage.put(key, existing ? { ...record, createdAt: existing.createdAt } : record);
      return existing ? "updated" : "created";
    },
    async get(id, now) {
      const sub = await storage.get<StoredSubscription>(`${SUB_PREFIX}${id}`);
      return sub && sub.expiresAt > now ? sub : null;
    },
    remove: (id) => storage.delete(`${SUB_PREFIX}${id}`),
    async list(now) {
      return [...(await live(now)).values()];
    },
    async verifiedUntil(key) {
      return (await storage.get<number>(`${VERIFIED_PREFIX}${key}`)) ?? 0;
    },
    async markVerified(key, until, now) {
      const entries = await storage.list<number>({ prefix: VERIFIED_PREFIX });
      for (const [k, expiresAt] of entries) if (expiresAt <= now) await storage.delete(k);
      await storage.put(`${VERIFIED_PREFIX}${key}`, until);
    },
  };
}

export class EventSubscriptions extends DurableObject {
  private store(): EventSubscriptionsStub {
    return subscriptionStore(this.ctx.storage as unknown as SubscriptionStorage);
  }

  upsert(record: StoredSubscription, now: number): Promise<UpsertResult> {
    return this.store().upsert(record, now);
  }

  get(id: string, now: number): Promise<StoredSubscription | null> {
    return this.store().get(id, now);
  }

  remove(id: string): Promise<boolean> {
    return this.store().remove(id);
  }

  list(now: number): Promise<StoredSubscription[]> {
    return this.store().list(now);
  }

  verifiedUntil(key: string): Promise<number> {
    return this.store().verifiedUntil(key);
  }

  markVerified(key: string, until: number, now: number): Promise<void> {
    return this.store().markVerified(key, until, now);
  }
}
