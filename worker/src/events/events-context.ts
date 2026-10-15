/**
 * The MCP Events context of one authenticated /mcp request: the caller's
 * subscription store (their own Durable Object), the key that encrypts
 * signing secrets at rest and the outbound fetch for callback checks.
 * Undefined when the Worker has no subscription Durable Object binding (then
 * events are not offered and server/discover does not advertise them).
 */

import { importEncryptionKey } from "../accounts/provider-secret-crypto.js";
import type { AppContext } from "../app-context.js";
import type { WorkerEnv } from "../config.js";
import { JobStore } from "../jobs/job-store.js";
import type { EventsContext } from "./events-methods.js";

export function eventsContextFor(
  env: WorkerEnv,
  app: AppContext,
  userId: string,
  clientId: string | undefined,
): EventsContext | undefined {
  if (!env.MULTIX_EVENT_SUBSCRIPTIONS) return undefined;
  return {
    userId,
    ...(clientId ? { clientId } : {}),
    subscriptions: env.MULTIX_EVENT_SUBSCRIPTIONS.getByName(userId),
    // resolveAppContext already proved the key imports.
    encryptionKey: importEncryptionKey(env.SECRETS_ENCRYPTION_KEY),
    fetch: app.fetch,
    jobs: new JobStore(env.ACCOUNTS_KV),
  };
}
