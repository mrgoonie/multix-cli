/**
 * The MCP Events context of one authenticated /mcp request: the caller's
 * AccountEvents object (their subscriptions and deliveries) and the outbound
 * fetch for callback checks. Undefined when the Worker has no MULTIX_EVENTS
 * binding (then events are not offered and server/discover does not
 * advertise them).
 */

import type { AppContext, AppDeps } from "../app-context.js";
import type { WorkerEnv } from "../config.js";
import { JobStore } from "../jobs/job-store.js";
import type { EventsContext } from "./events-methods.js";

export function eventsContextFor(
  env: WorkerEnv,
  app: AppContext,
  deps: AppDeps,
  userId: string,
  clientId: string | undefined,
): EventsContext | undefined {
  const namespace = deps.events ?? env.MULTIX_EVENTS;
  if (!namespace) return undefined;
  return {
    userId,
    ...(clientId ? { clientId } : {}),
    events: namespace.getByName(userId),
    origin: app.origin,
    fetch: app.fetch,
    jobs: new JobStore(env.ACCOUNTS_KV),
  };
}
