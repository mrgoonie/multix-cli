/**
 * REST handlers for job event webhooks: the event catalog, the account's
 * subscriptions, dead letters and the audit log. Everything is addressed by
 * the calling account, so one account never sees or changes another's
 * subscriptions. The signing secret is returned once, on create.
 */

import type { AppContext, AppDeps } from "../app-context.js";
import type { AccountEventsStub } from "../events/account-events.js";
import {
  CallbackDnsError,
  CallbackUrlError,
  assertPublicCallbackUrl,
} from "../events/callback-guard.js";
import { EVENT_CATALOG } from "../events/event-catalog.js";
import type { AuditEntry, DeadLetter } from "../events/event-hub.js";
import { parseSubscriptionInput } from "../events/subscription-input.js";
import { TIMESTAMP_TOLERANCE_SECONDS } from "../events/webhook-signing.js";
import { json } from "../http-responses.js";
import { logEvent } from "../redaction.js";
import type { ApiCaller } from "./account-api-handlers.js";
import { ApiError, readJsonObject } from "./api-http.js";

const iso = (ms: number) => new Date(ms).toISOString();

export function eventsHub(app: AppContext, deps: AppDeps, userId: string): AccountEventsStub {
  const namespace = deps.events ?? app.env.MULTIX_EVENTS;
  if (!namespace) throw new ApiError(503, "unavailable", "Events are not available on this server");
  return namespace.getByName(userId);
}

export function getEventCatalog(): Response {
  return json(200, { events: EVENT_CATALOG });
}

export async function listSubscriptions(hub: AccountEventsStub): Promise<Response> {
  return json(200, { subscriptions: await hub.listSubscriptions() });
}

export async function createSubscription(
  app: AppContext,
  hub: AccountEventsStub,
  caller: ApiCaller,
  request: Request,
): Promise<Response> {
  const input = parseSubscriptionInput(await readJsonObject(request), app.origin);
  try {
    await assertPublicCallbackUrl(input.callbackUrl, app.fetch, "callback_url");
  } catch (error) {
    if (error instanceof CallbackUrlError) throw new ApiError(400, "bad_request", error.message);
    if (error instanceof CallbackDnsError) {
      throw new ApiError(
        503,
        "unavailable",
        "Could not resolve the callback_url host; retry later",
        {
          "retry-after": "30",
        },
      );
    }
    throw error;
  }
  const result = await hub.subscribe(input, `api_key:${caller.keyId}`);
  if (!result.ok) throw new ApiError(409, "limit_reached", result.message);
  logEvent("info", "event_subscription_created", { user: caller.account.id });
  return json(201, {
    subscription: result.subscription,
    secret: result.secret,
    signing: {
      scheme: "Standard Webhooks (HMAC-SHA256)",
      headers: ["webhook-id", "webhook-timestamp", "webhook-signature"],
      signed_content: "<webhook-id>.<webhook-timestamp>.<raw body>",
      timestamp_tolerance_seconds: TIMESTAMP_TOLERANCE_SECONDS,
      note: "Store the secret now: it is not shown again. Dedupe deliveries on webhook-id.",
    },
  });
}

export async function getSubscription(hub: AccountEventsStub, id: string): Promise<Response> {
  const subscription = await hub.getSubscription(id);
  if (!subscription) throw new ApiError(404, "not_found", "Subscription not found");
  return json(200, { subscription });
}

export async function deleteSubscription(
  hub: AccountEventsStub,
  caller: ApiCaller,
  id: string,
): Promise<Response> {
  if (!(await hub.unsubscribe(id, `api_key:${caller.keyId}`))) {
    throw new ApiError(404, "not_found", "Subscription not found");
  }
  logEvent("info", "event_subscription_revoked", { user: caller.account.id });
  return json(200, { revoked: id });
}

function deadLetterView(entry: DeadLetter) {
  return {
    id: entry.id,
    subscription_id: entry.subscriptionId,
    event_id: entry.eventId,
    event: entry.eventName,
    attempts: entry.attempts,
    reason: entry.reason,
    last_status: entry.lastStatus ?? null,
    at: iso(entry.at),
  };
}

function auditView(entry: AuditEntry) {
  return {
    at: iso(entry.at),
    action: entry.action,
    actor: entry.actor,
    subscription_id: entry.subscriptionId ?? null,
    detail: entry.detail ?? null,
  };
}

export async function listDeadLetters(hub: AccountEventsStub): Promise<Response> {
  return json(200, { dead_letters: (await hub.deadLetters()).map(deadLetterView) });
}

export async function listAudit(hub: AccountEventsStub): Promise<Response> {
  return json(200, { audit: (await hub.auditLog()).map(auditView) });
}
