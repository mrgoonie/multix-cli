/**
 * Durable Object holding one account's event subscriptions and deliveries
 * (`MULTIX_EVENTS.getByName(userId)`), so an event published for an account
 * can only ever reach that account's subscriptions. The logic lives in
 * EventHub; this class binds it to Durable Object storage, the alarm and the
 * Worker's fetch.
 */

import { DurableObject } from "cloudflare:workers";
import type { MultixEvent } from "./event-catalog.js";
import {
  type AuditEntry,
  type DeadLetter,
  EventHub,
  type HubStorage,
  type McpSubscriptionInput,
  type McpSubscriptionState,
  type McpUpsertResult,
  type SubscribeResult,
  type SubscriptionInput,
  type SubscriptionView,
} from "./event-hub.js";

export class AccountEvents extends DurableObject {
  private readonly hub = new EventHub({
    storage: this.ctx.storage as unknown as HubStorage,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
  });

  publish(events: MultixEvent[]): Promise<{ accepted: number; duplicates: number }> {
    return this.hub.publish(events);
  }

  subscribe(input: SubscriptionInput, actor: string): Promise<SubscribeResult> {
    return this.hub.subscribe(input, actor);
  }

  mcpSubscriptionState(
    id: string,
    callbackUrl: string,
    secret: string,
  ): Promise<McpSubscriptionState> {
    return this.hub.mcpSubscriptionState(id, callbackUrl, secret);
  }

  upsertMcpSubscription(input: McpSubscriptionInput, actor: string): Promise<McpUpsertResult> {
    return this.hub.upsertMcpSubscription(input, actor);
  }

  removeByClient(clientId: string, actor: string): Promise<number> {
    return this.hub.removeByClient(clientId, actor);
  }

  listSubscriptions(): Promise<SubscriptionView[]> {
    return this.hub.listSubscriptions();
  }

  getSubscription(id: string): Promise<SubscriptionView | null> {
    return this.hub.getSubscription(id);
  }

  unsubscribe(id: string, actor: string): Promise<boolean> {
    return this.hub.unsubscribe(id, actor);
  }

  deadLetters(limit?: number): Promise<DeadLetter[]> {
    return this.hub.deadLetters(limit);
  }

  auditLog(limit?: number): Promise<AuditEntry[]> {
    return this.hub.auditLog(limit);
  }

  override async alarm(): Promise<void> {
    await this.hub.alarm();
  }
}

/** RPC surface of AccountEvents used by the Worker and the job Durable Object. */
export interface AccountEventsStub {
  publish(events: MultixEvent[]): Promise<{ accepted: number; duplicates: number }>;
  subscribe(input: SubscriptionInput, actor: string): Promise<SubscribeResult>;
  mcpSubscriptionState(
    id: string,
    callbackUrl: string,
    secret: string,
  ): Promise<McpSubscriptionState>;
  upsertMcpSubscription(input: McpSubscriptionInput, actor: string): Promise<McpUpsertResult>;
  removeByClient(clientId: string, actor: string): Promise<number>;
  listSubscriptions(): Promise<SubscriptionView[]>;
  getSubscription(id: string): Promise<SubscriptionView | null>;
  unsubscribe(id: string, actor: string): Promise<boolean>;
  deadLetters(limit?: number): Promise<DeadLetter[]>;
  auditLog(limit?: number): Promise<AuditEntry[]>;
}

export interface AccountEventsNamespace {
  getByName(name: string): AccountEventsStub;
}
