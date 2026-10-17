/**
 * Validation of a new REST subscription's fields. The callback must be a
 * public https URL by host name (url-guard.ts) and may not point back at this
 * server. Its resolved addresses are checked separately, since that needs
 * DNS: by the REST handler at subscribe time and by EventHub before every
 * delivery (callback-guard.ts). `global_fetch_strictly_public` is not an
 * address filter and does not cover this. Redirects are never followed, so a
 * callback cannot be bounced to an internal host.
 */

import { ValidationError } from "../../../src/core/errors.js";
import { assertPublicHttpsUrl } from "../url-guard.js";
import { EVENT_NAMES, type EventName, isEventName } from "./event-catalog.js";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  MAX_SUBSCRIPTION_TTL_SECONDS,
  MIN_SUBSCRIPTION_TTL_SECONDS,
  type SubscriptionInput,
} from "./event-hub.js";

export const MAX_DESCRIPTION_CHARS = 200;

/** Check raw input (snake_case, as sent by clients); throws ValidationError. */
export function parseSubscriptionInput(
  raw: Record<string, unknown>,
  ownOrigin: string,
): SubscriptionInput {
  const { callback_url: callback, events, ttl_seconds: ttl, description } = raw;
  if (typeof callback !== "string" || !callback) {
    throw new ValidationError("callback_url is required: the https URL that receives events");
  }
  const callbackUrl = assertPublicHttpsUrl(callback, "callback_url");
  const ownHost = new URL(ownOrigin).hostname.toLowerCase();
  const host = new URL(callbackUrl).hostname.toLowerCase().replace(/\.$/, "");
  if (host === ownHost) throw new ValidationError("callback_url must not point at this server");

  let names: EventName[] = [...EVENT_NAMES];
  if (events !== undefined) {
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > EVENT_NAMES.length * 2 ||
      !events.every(isEventName)
    ) {
      throw new ValidationError(`events must be a non-empty list of: ${EVENT_NAMES.join(", ")}`);
    }
    names = [...new Set(events)];
  }

  let ttlSeconds = DEFAULT_SUBSCRIPTION_TTL_SECONDS;
  if (ttl !== undefined) {
    if (
      typeof ttl !== "number" ||
      !Number.isInteger(ttl) ||
      ttl < MIN_SUBSCRIPTION_TTL_SECONDS ||
      ttl > MAX_SUBSCRIPTION_TTL_SECONDS
    ) {
      throw new ValidationError(
        `ttl_seconds must be an integer from ${MIN_SUBSCRIPTION_TTL_SECONDS} to ${MAX_SUBSCRIPTION_TTL_SECONDS}`,
      );
    }
    ttlSeconds = ttl;
  }

  const input: SubscriptionInput = { callbackUrl, events: names, ttlSeconds };
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) {
      throw new ValidationError(
        `description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters`,
      );
    }
    if (description.trim()) input.description = description.trim();
  }
  return input;
}
