/**
 * MCP Events methods (protocol 2026-07-28, OpenAI MCP Events / SEP-3415
 * draft): `events/list`, `events/subscribe` and `events/unsubscribe` on the
 * same authenticated /mcp endpoint as the tools. Registered only on modern
 * (2026-07-28) server instances; 2025-era clients keep the tools-only surface.
 *
 * Every call acts for the account whose OAuth token reached /mcp: the
 * subscriptions live in that account's Durable Object and the subscription id
 * is derived from the account id, so one account can never see, refresh or
 * remove another account's subscription.
 */

import { type McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FetchLike } from "../../../src/core/fetch-json.js";
import { decryptSecret, encryptSecret } from "../accounts/provider-secret-crypto.js";
import { MAX_URL_CHARS } from "../config.js";
import type { JobStore } from "../jobs/job-store.js";
import { logEvent, sanitizeText } from "../redaction.js";
import { assertPublicHttpsUrl } from "../url-guard.js";
import { CallbackDnsError, CallbackUrlError, assertPublicCallbackUrl } from "./callback-guard.js";
import { type VerificationFailure, verifyCallback } from "./callback-verification.js";
import {
  DELIVERY_MODES,
  type JobEventArguments,
  eventCatalog,
  isKnownEvent,
  jobEventArguments,
} from "./event-catalog.js";
import {
  type EventSubscriptionsStub,
  MAX_SUBSCRIPTIONS_PER_ACCOUNT,
  type StoredSubscription,
} from "./event-subscriptions.js";
import { sha256Hex, subscriptionId } from "./subscription-identity.js";
import { MAX_SECRET_CHARS, isValidSecret } from "./webhook-signing.js";

/** `CallbackEndpointError` in the OpenAI MCP Events guide. */
export const CALLBACK_ENDPOINT_ERROR = -32015;

export const DEFAULT_TTL_MS = 24 * 60 * 60_000;
export const MIN_TTL_MS = 5 * 60_000;
export const MAX_TTL_MS = 7 * 24 * 60 * 60_000;
/** A passed verification is reused this long for the same callback URL and secret. */
export const VERIFICATION_CACHE_MS = 24 * 60 * 60_000;
/** After a refresh changes the secret, deliveries are signed with both for this long. */
export const SECRET_ROTATION_MS = 60 * 60_000;

export interface EventsContext {
  userId: string;
  /** OAuth client of the token, recorded on the subscription for audit. */
  clientId?: string;
  subscriptions: EventSubscriptionsStub;
  /** AES-GCM key for signing secrets at rest (SECRETS_ENCRYPTION_KEY). */
  encryptionKey: Promise<CryptoKey>;
  /** Outbound fetch for DNS checks and verification. */
  fetch: FetchLike;
  /** Ownership records, to check a `job_id` filter belongs to the caller. */
  jobs?: JobStore;
  now?: () => number;
}

const MAX_EVENT_NAME_CHARS = 128;

const deliveryTarget = z.object({
  mode: z.string().max(32),
  url: z.string().max(MAX_URL_CHARS),
});

const listParams = z.object({ cursor: z.string().max(256).optional() }).loose();

const subscribeParams = z
  .object({
    name: z.string().max(MAX_EVENT_NAME_CHARS),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: deliveryTarget.extend({ secret: z.string().max(MAX_SECRET_CHARS) }),
    cursor: z.string().max(256).nullable().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
  })
  .loose();

const unsubscribeParams = z
  .object({
    name: z.string().max(MAX_EVENT_NAME_CHARS),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: deliveryTarget,
  })
  .loose();

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function callbackError(reason: VerificationFailure): ProtocolError {
  return new ProtocolError(CALLBACK_ENDPOINT_ERROR, "Callback endpoint verification failed", {
    reason,
  });
}

/** Granted lifetime: the requested one within [MIN_TTL_MS, MAX_TTL_MS]; never unlimited. */
export function grantedTtlMs(requested: number | null | undefined): number {
  if (requested === undefined) return DEFAULT_TTL_MS;
  if (requested === null) return MAX_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(requested, MAX_TTL_MS));
}

function checkEvent(name: string, mode: string): void {
  if (!isKnownEvent(name)) throw invalidParams(`Unknown event: ${name.slice(0, 64)}`);
  if (!(DELIVERY_MODES as readonly string[]).includes(mode)) {
    throw invalidParams(`Unsupported delivery mode; supported: ${DELIVERY_MODES.join(", ")}`);
  }
}

function parseArguments(raw: Record<string, unknown> | undefined): JobEventArguments {
  const parsed = jobEventArguments.safeParse(raw ?? {});
  if (!parsed.success) throw invalidParams("arguments do not match the event's inputSchema");
  return parsed.data;
}

/**
 * Run a handler so that only protocol errors reach the client: anything else
 * (storage, crypto, RPC) is logged and answered with a generic internal error.
 */
function guarded<P, R>(method: string, handler: (params: P) => Promise<R>) {
  return async (params: P): Promise<R> => {
    try {
      return await handler(params);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      logEvent("error", "event_method_failed", {
        method,
        error: error instanceof Error ? error.name : typeof error,
        detail: sanitizeText(error instanceof Error ? error.message : String(error), []),
      });
      throw new ProtocolError(ProtocolErrorCode.InternalError, "Internal error");
    }
  };
}

function secretAad(id: string): string {
  return `event-subscription:${id}`;
}

export function registerEventMethods(server: McpServer, ctx: EventsContext): void {
  const now = ctx.now ?? Date.now;

  server.server.setRequestHandler(
    "events/list",
    { params: listParams },
    guarded("events/list", async () => ({ events: eventCatalog() })),
  );

  const subscribe = guarded("events/subscribe", async (p: z.infer<typeof subscribeParams>) => {
    checkEvent(p.name, p.delivery.mode);
    const args = parseArguments(p.arguments);
    if (args.job_id !== undefined && !(await ctx.jobs?.ownedBy(args.job_id, ctx.userId))) {
      throw invalidParams("Job not found");
    }
    if (!isValidSecret(p.delivery.secret)) {
      throw invalidParams("delivery.secret must be whsec_ followed by base64 of 24-64 bytes");
    }
    let url: string;
    try {
      url = await assertPublicCallbackUrl(p.delivery.url, ctx.fetch);
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message);
      if (error instanceof CallbackDnsError) throw callbackError("connection_refused");
      throw error;
    }

    const id = await subscriptionId({
      principal: ctx.userId,
      url,
      name: p.name,
      arguments: args,
    });
    const started = now();
    const existing = await ctx.subscriptions.get(id, started);
    if (
      !existing &&
      (await ctx.subscriptions.list(started)).length >= MAX_SUBSCRIPTIONS_PER_ACCOUNT
    ) {
      throw invalidParams(`Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_ACCOUNT})`);
    }

    const verificationKey = await sha256Hex(`${url}\n${p.delivery.secret}`);
    if ((await ctx.subscriptions.verifiedUntil(verificationKey)) <= started) {
      const failure = await verifyCallback(ctx.fetch, url, p.delivery.secret, id, now);
      if (failure) {
        logEvent("warn", "event_subscribe", { eventName: p.name, ok: false, reason: failure });
        throw callbackError(failure);
      }
      await ctx.subscriptions.markVerified(verificationKey, now() + VERIFICATION_CACHE_MS, now());
    }

    const key = await ctx.encryptionKey;
    const at = now();
    let previousSecret = existing?.previousSecret;
    if (previousSecret && previousSecret.until <= at) previousSecret = undefined;
    if (existing) {
      const current = await decryptSecret(key, ctx.userId, secretAad(id), existing.secret).catch(
        () => null,
      );
      if (current !== p.delivery.secret && current !== null) {
        previousSecret = { secret: existing.secret, until: at + SECRET_ROTATION_MS };
      }
    }
    const expiresAt = at + grantedTtlMs(p.ttlMs);
    const record: StoredSubscription = {
      id,
      name: p.name,
      arguments: args,
      url,
      secret: await encryptSecret(key, ctx.userId, secretAad(id), p.delivery.secret),
      ...(previousSecret ? { previousSecret } : {}),
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      createdAt: at,
      updatedAt: at,
      expiresAt,
    };
    const result = await ctx.subscriptions.upsert(record, at);
    if (result === "limit") {
      throw invalidParams(`Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_ACCOUNT})`);
    }
    logEvent("info", "event_subscribe", { eventName: p.name, id, ok: true, result });
    return {
      id,
      refreshBefore: new Date(expiresAt).toISOString(),
      cursor: null,
      // No replay: history before this subscription is never available.
      truncated: p.cursor !== undefined && p.cursor !== null,
    };
  });
  server.server.setRequestHandler("events/subscribe", { params: subscribeParams }, subscribe);

  // Unsubscribe is idempotent: a target subscribe would have refused (unknown
  // event, mode, arguments or URL) cannot exist, so it answers like any other
  // subscription that is already gone.
  const unsubscribe = guarded(
    "events/unsubscribe",
    async (p: z.infer<typeof unsubscribeParams>) => {
      if (
        !isKnownEvent(p.name) ||
        !(DELIVERY_MODES as readonly string[]).includes(p.delivery.mode)
      ) {
        return {};
      }
      const args = jobEventArguments.safeParse(p.arguments ?? {});
      if (!args.success) return {};
      let url: string;
      try {
        url = assertPublicHttpsUrl(p.delivery.url, "delivery.url");
      } catch {
        return {};
      }
      const id = await subscriptionId({
        principal: ctx.userId,
        url,
        name: p.name,
        arguments: args.data,
      });
      const removed = await ctx.subscriptions.remove(id);
      logEvent("info", "event_unsubscribe", { eventName: p.name, id, removed });
      return {};
    },
  );
  server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeParams }, unsubscribe);
}
