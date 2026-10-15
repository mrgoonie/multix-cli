/**
 * REST API for scripts and CI, authenticated with account API keys created in
 * /dashboard (`Authorization: Bearer mxk_…`).
 *
 *   GET    /api/v1/openapi.json                public: OpenAPI 3.1 document
 *   GET    /api/v1/me                          the calling account
 *   GET    /api/v1/provider-keys               which provider keys are set (never values)
 *   PATCH  /api/v1/provider-keys               set and remove several keys at once
 *   PUT    /api/v1/provider-keys/{name}        set one key
 *   DELETE /api/v1/provider-keys/{name}        remove one key
 *   GET    /api/v1/storage                     R2 settings without credentials
 *   PUT    /api/v1/storage                     check access, then save R2 settings
 *   DELETE /api/v1/storage                     remove R2 settings
 *   GET    /api/v1/catalog[?group=]            CLI commands the server can run
 *   POST   /api/v1/jobs                        run a CLI command (same input as multix_run)
 *   GET    /api/v1/jobs/{id}                   job status and outputs
 *   POST   /api/v1/jobs/{id}/cancel            stop a job
 *   GET    /api/v1/events                      job events the server publishes
 *   GET    /api/v1/events/subscriptions        the account's webhook subscriptions (no secrets)
 *   POST   /api/v1/events/subscriptions        subscribe a callback URL (secret shown once)
 *   GET    /api/v1/events/subscriptions/{id}   one subscription
 *   DELETE /api/v1/events/subscriptions/{id}   revoke a subscription
 *   GET    /api/v1/events/dead-letters         deliveries that were given up
 *   GET    /api/v1/events/audit                subscription audit log
 *   GET    /api/v1/api-keys                    the account's API keys (no values)
 *   DELETE /api/v1/api-keys/{id}               revoke an API key
 *
 * Every authenticated request checks the key, the per-account rate limit
 * shared with /mcp and the sign-in allowlist. Failed authentication is rate
 * limited per IP.
 */

import { toolEnvFor } from "../accounts/account-store.js";
import { isAllowed } from "../accounts/allowlist.js";
import { ApiKeyStore } from "../accounts/api-key-store.js";
import type { AppContext, AppDeps } from "../app-context.js";
import { limitsFrom, secretValues, serverSettings } from "../config.js";
import { json } from "../http-responses.js";
import { jobsContextFor } from "../jobs/job-context.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import {
  type ApiCaller,
  deleteProviderKey,
  deleteStorage,
  getMe,
  getStorage,
  listApiKeys,
  listProviderKeys,
  patchProviderKeys,
  putProviderKey,
  putStorage,
  revokeApiKey,
} from "./account-api-handlers.js";
import { ApiError, apiError, errorResponse } from "./api-http.js";
import {
  createSubscription,
  deleteSubscription,
  eventsHub,
  getEventCatalog,
  getSubscription,
  listAudit,
  listDeadLetters,
  listSubscriptions,
} from "./event-api-handlers.js";
import { cancelJob, getCatalog, getJob, postJob } from "./job-api-handlers.js";
import { openApiDocument } from "./openapi-document.js";

export const API_PREFIX = "/api/v1";

const BEARER_RE = /^Bearer\s+(\S+)$/i;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

function methodNotAllowed(allow: string): never {
  throw new ApiError(405, "method_not_allowed", "Method not allowed", { allow });
}

async function authenticate(app: AppContext, request: Request): Promise<ApiCaller | Response> {
  const match = BEARER_RE.exec(request.headers.get("authorization") ?? "");
  const presented = match?.[1];
  const owner = presented ? await new ApiKeyStore(app.env.ACCOUNTS_KV).verify(presented) : null;
  if (!owner) {
    const limiter = app.env.AUTH_RATE_LIMITER;
    if (limiter) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await limiter.limit({ key });
      if (!success) {
        return apiError(429, "rate_limited", "Too many requests", { "retry-after": "60" });
      }
    }
    return apiError(
      401,
      "unauthorized",
      "Send an API key from /dashboard as Authorization: Bearer <key>",
      { "www-authenticate": 'Bearer realm="multix"' },
    );
  }
  // Per-account limit before the allowlist, so a key of a removed account is limited too.
  const limiter = app.env.MCP_RATE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: owner.userId });
    if (!success) {
      return apiError(429, "rate_limited", "Too many requests", { "retry-after": "60" });
    }
  }
  const account = await app.accounts.get(owner.userId);
  if (!account || !isAllowed(app.env.MULTIX_ALLOWED_USERS, account)) {
    return apiError(403, "forbidden", "This account may not use the API");
  }
  return { account, keyId: owner.keyId };
}

/** Split `/api/v1/a/b/c` into validated segments after the prefix. */
function segments(pathname: string): string[] {
  const rest = pathname.slice(API_PREFIX.length).replace(/^\/+|\/+$/g, "");
  const parts = rest ? rest.split("/") : [];
  if (parts.some((p) => !SEGMENT_RE.test(p))) throw new ApiError(404, "not_found", "Not found");
  return parts;
}

async function route(
  app: AppContext,
  deps: AppDeps,
  caller: ApiCaller,
  keys: ProviderKeys,
  request: Request,
  parts: string[],
  url: URL,
): Promise<Response> {
  const method = request.method;
  const [resource, id, action] = parts;
  const userId = caller.account.id;

  if (resource === "me" && !id) {
    if (method !== "GET") methodNotAllowed("GET");
    return getMe(caller);
  }

  if (resource === "provider-keys" && !action) {
    if (!id) {
      if (method === "GET") return listProviderKeys(app, caller);
      if (method === "PATCH") return patchProviderKeys(app, caller, request);
      methodNotAllowed("GET, PATCH");
    }
    if (method === "PUT") return putProviderKey(app, caller, id, request);
    if (method === "DELETE") return deleteProviderKey(app, caller, id);
    methodNotAllowed("PUT, DELETE");
  }

  if (resource === "storage" && !id) {
    if (method === "GET") return getStorage(app, caller);
    if (method === "PUT") return putStorage(app, caller, request);
    if (method === "DELETE") return deleteStorage(app, caller);
    methodNotAllowed("GET, PUT, DELETE");
  }

  if (resource === "api-keys" && !action) {
    if (!id) {
      if (method !== "GET") methodNotAllowed("GET");
      return listApiKeys(app, caller);
    }
    if (method !== "DELETE") methodNotAllowed("DELETE");
    return revokeApiKey(app, caller, id);
  }

  if (resource === "catalog" && !id) {
    if (method !== "GET") methodNotAllowed("GET");
    return getCatalog(keys, url);
  }

  if (resource === "jobs") {
    const jobs = jobsContextFor(app.env, app, userId, keys, deps);
    if (!id) {
      if (method !== "POST") methodNotAllowed("POST");
      const limits = limitsFrom(toolEnvFor(serverSettings(app.env), keys));
      return postJob(jobs, limits, request);
    }
    if (!action) {
      if (method !== "GET") methodNotAllowed("GET");
      return getJob(jobs, id);
    }
    if (action === "cancel" && parts.length === 3) {
      if (method !== "POST") methodNotAllowed("POST");
      return cancelJob(jobs, id);
    }
  }

  if (resource === "events") {
    return routeEvents(app, deps, caller, request, parts.slice(1));
  }

  throw new ApiError(404, "not_found", "Not found");
}

async function routeEvents(
  app: AppContext,
  deps: AppDeps,
  caller: ApiCaller,
  request: Request,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const [collection, id, extra] = parts;
  if (!collection) {
    if (method !== "GET") methodNotAllowed("GET");
    return getEventCatalog();
  }
  const hub = () => eventsHub(app, deps, caller.account.id);
  if (collection === "subscriptions" && !extra) {
    if (!id) {
      if (method === "GET") return listSubscriptions(hub());
      if (method === "POST") return createSubscription(app, hub(), caller, request);
      methodNotAllowed("GET, POST");
    }
    if (method === "GET") return getSubscription(hub(), id);
    if (method === "DELETE") return deleteSubscription(hub(), caller, id);
    methodNotAllowed("GET, DELETE");
  }
  if ((collection === "dead-letters" || collection === "audit") && !id) {
    if (method !== "GET") methodNotAllowed("GET");
    return collection === "audit" ? listAudit(hub()) : listDeadLetters(hub());
  }
  throw new ApiError(404, "not_found", "Not found");
}

export async function handleApi(
  app: AppContext,
  deps: AppDeps,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === `${API_PREFIX}/openapi.json`) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return apiError(405, "method_not_allowed", "Method not allowed", { allow: "GET" });
    }
    return json(200, openApiDocument(app.origin), { "access-control-allow-origin": "*" });
  }
  let routeName = "unknown";
  let secrets: string[] = [];
  try {
    const parts = segments(url.pathname);
    routeName = parts[0] ?? "root";
    const caller = await authenticate(app, request);
    if (caller instanceof Response) return caller;
    // Only the catalog and jobs use the decrypted keys; the other routes must keep
    // working (e.g. to revoke an API key) even if a stored key cannot be decrypted.
    const needsKeys = routeName === "catalog" || routeName === "jobs";
    const keys: ProviderKeys = needsKeys ? await app.accounts.providerKeys(caller.account.id) : {};
    // Scrub the caller's own key values from any error message that echoes CLI output.
    secrets = secretValues(keys);
    return await route(app, deps, caller, keys, request, parts, url);
  } catch (error) {
    return errorResponse(error, routeName, secrets);
  }
}
