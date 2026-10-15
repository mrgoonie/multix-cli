# Code review: MCP Events on the AccountEvents hub

Branch `claude/gracious-heisenberg-ppahvw`, integration delta `230b527..HEAD` (merge 0e76392), focused on
`worker/src/events/*`, `worker/src/routes/dashboard-routes.ts`, `worker/src/index.ts`.

Checks run: `npx vitest run` passed (21 files, 347 tests). `npx tsc --noEmit -p tsconfig.test.json` is clean.

Excluded because they are already tracked or accepted: re-checking DNS on every delivery (#226), and event replay.

## Overall

The integration is sound. Isolation between accounts holds: each account gets its own DO through `getByName(userId)`, and the subscription id is derived from `userId`. REST ids (`sub_` + 16 base64url characters) and MCP ids (`sub_` + 24 hex characters) cannot collide. Failures from the DO come back as values; nothing relies on a thrown error keeping its class across RPC. The limit is checked again inside `upsertMcpSubscription`. A refresh of a disabled or expired subscription has to pass verification again, because `verified` requires `live`. I found no High-severity defect. The findings below are about revoke, a race, and REST visibility.

## Medium

### M1. A connection revoke can leave MCP subscriptions behind (failure ordering)
`worker/src/routes/dashboard-routes.ts:178-181`

`revokeGrant` runs before `removeClientSubscriptions`, and nothing protects the second call. Failure path:
1. The user clicks Disconnect. `revokeGrant` succeeds.
2. `getByName(userId).removeByClient(...)` throws (DO overloaded or reset, or an RPC error). The request returns 500.
3. The user retries. The grant has already been deleted, so `grant` is `undefined` and `removed` is 0. The page no longer lists the connection either.

The client's subscriptions keep receiving job events at its callback until they expire (up to 7 days). This breaks the documented promise "Disconnecting a client in the dashboard removes the subscriptions it made" (`docs-site/.../mcp-server.md`).

Fix: remove the subscriptions first, then revoke. Exclude `grantId` from the "another grant for the same client" check, for example `remaining.items.some(g => g.clientId === clientId && g.id !== grantId)`. Alternatively, keep the current order but catch and log, and add a sweep. Add a test that makes `removeByClient` throw once and checks that a retry or the ordering still removes the subscriptions.

### M2. A subscribe in flight, or a token still cached, can recreate a subscription after the revoke
`worker/src/events/events-methods.ts:176-200`, `worker/src/events/event-hub.ts:378-385`

`events/subscribe` reads state, then calls `verifyCallback`, which can take up to 10 s on the network, and only then calls `upsertMcpSubscription`. `removeByClient` only deletes records that exist when it runs. Failure path:
1. The client calls `events/subscribe` with a token that is still valid.
2. During verification, the user revokes the connection. `removeByClient` finds nothing, or only the older records.
3. `upsertMcpSubscription` then writes a new record with the revoked `clientId`.

The same thing happens without a race. `revokeGrant` deletes the token in KV, but a KV `get` at another edge location can serve the cached token for about 60 s, so the revoked client can still subscribe in that window. In both cases a subscription from a revoked client stays active for up to 7 days.

Fix: in `removeByClient`, write a tombstone `revoked-client:<clientId>` with a timestamp. In `upsertMcpSubscription`, refuse `input.clientId` when a tombstone is newer than the grant the token came from, or newer than a few minutes for simplicity. Housekeeping clears the tombstones. Another option is to check that the grant still exists right before the upsert. That is cheaper but still subject to KV caching.

### M3. REST shows MCP subscriptions without their job filter or origin
`worker/src/events/event-hub.ts:230-246` (`subscriptionView`), `worker/src/api/event-api-handlers.ts:31-62`

`GET /api/v1/events/subscriptions` now returns MCP records. The view looks exactly like a REST subscription: `events: ["multix.job.completed"]`, with no `job_id` and nothing showing it was made over MCP. A REST user who sees it will reasonably expect it to fire for every job, but it fires for one job only (`event-hub.ts:452`). The user also has no way to tell which entries are taking the shared limit of 10 slots, which is what produces a REST `409 limit_reached` that never happened before an MCP client connected.

`openapi-document.ts:294` still says only "At most 10 active subscriptions per account". It does not mention that MCP subscriptions count toward that limit or appear in the list.

Fix: add optional fields to `SubscriptionView`, which is an additive and compatible change. For example `source: "mcp"` and `job_id`, but never `clientId` or a secret. Update the OpenAPI description of the list and create endpoints to match.

## Low

### L1. Skipping verification is a check-then-act across two DO calls
`worker/src/events/events-methods.ts:176-189`

`mcpSubscriptionState` returns `verified: true` because the subscription is live. A delivery then answers 410 and disables it (`deadLetterDelivery`, `event-hub.ts:660`). `upsertMcpSubscription` then brings it back as `active` with `consecutiveDeadLetters = 0` and no new verification. The window is small: two RPC calls with no network call in between, but alarm deliveries can run between them.

Fix: pass `requireLive: true` (or the `verified` flag) into `upsertMcpSubscription`, and return `{ ok: false, error: "needs_verification" }` when the record is no longer live. The handler then verifies and tries again.

### L2. `refreshBefore` is the hard expiry, and late refreshes inherit inflated dead-letter counts
`worker/src/events/events-methods.ts:210`, `worker/src/events/event-hub.ts:529-531, 657-663, 363`

`refreshBefore` equals `expiresAt`, so there is no grace period. Between `expiresAt` and the next housekeeping run (up to 6 h), the status stays `"active"`. During that time:
- Queued retries are dead-lettered with the reason "subscription active".
- Each one increments `consecutiveDeadLetters`, because the guard checks `status !== "active"` and not liveness.

A refresh in this state keeps the inflated count (`existing.status === "active"`, line 363). Five such dead letters disable the subscription with the misleading reason "5 deliveries in a row failed".

The underlying behaviour already existed for REST. MCP's short TTLs (24 h default, 5 min minimum) make it much more likely to be hit.

Fix:
- Use `this.isLive(sub, at)` in the `deadLetterDelivery` guard and in line 363.
- Label the reason "subscription expired" when `expiresAt <= now`.
- Optionally return a `refreshBefore` somewhat earlier than `expiresAt`, for example 10% of the TTL.

### L3. Expired MCP records pile up for 30 days
`worker/src/events/event-hub.ts:698`

MCP subscriptions cannot be revived except by subscribing again, and the minimum TTL is 5 minutes. An expired record is kept for 30 days (`RECORD_RETENTION_MS`). Every `publish` (`subscriptions()` for each event), `listSubscriptions`, `removeByClient` and `liveCount` scans all `sub:` records.

A client that cycles distinct callback URLs can create up to 10 records every 5 minutes. That is about 86k records over 30 days, bounded only by the per-account MCP rate limiter. The account slows itself down, and the REST list response grows without bound. The impact stays within that one account.

Fix: drop MCP records soon after expiry, for example 1 day. Optionally paginate the REST list.

### L4. `removeByClient` follows the last refresher, not the creator
`worker/src/events/event-hub.ts:352, 378`

`mcp.clientId` is overwritten on every refresh. If client A creates a subscription and client B of the same account refreshes it (same URL, event and arguments), revoking A leaves the subscription in place. The docs say revoke removes "the subscriptions it made". The case is unlikely in practice, but the docs should say "created or last refreshed", as the code comment already does.

### L5. Revoke reads the binding differently from the other paths
`worker/src/routes/dashboard-routes.ts:62`

The revoke path reads `ctx.env.MULTIX_EVENTS` directly. `eventsHub` and `eventsContextFor` both use `deps.events ?? env.MULTIX_EVENTS`. In production `deps.events` is never set, so this does nothing there. A test harness that injects `deps.events` would, however, quietly skip removing subscriptions on revoke. Use the same resolution everywhere.

## Test gaps
- `worker/test/event-hub.test.ts` has no unit tests for `upsertMcpSubscription`, `mcpSubscriptionState` or `removeByClient`. Missing cases:
  - reviving a disabled or expired record resets the counters and needs verification (`verified: false`);
  - `atLimit` when an expired record with the same id exists;
  - after `MCP_SECRET_ROTATION_MS`, exactly one signature is sent;
  - an expired `previousSecret` is dropped on refresh.
- `mcp-events-oauth.test.ts:98` covers only the happy-path revoke. Not covered:
  - keeping subscriptions while another grant for the same client remains;
  - `removeByClient` failing (M1);
  - a subscribe racing the revoke (M2).
- No REST test checks that MCP subscriptions appear in `GET/DELETE /api/v1/events/subscriptions`, or that a REST DELETE followed by an MCP refresh verifies again.
- No test sends a REST subscription and an MCP subscription in the same publish and checks that the REST one still gets the REST envelope with no `x-mcp-subscription-id` header. This guards REST backwards compatibility in `send()`.

## Verified non-issues
- An MCP unsubscribe cannot remove a REST subscription, because the id formats differ (16 vs 24 characters).
- Subscribe and unsubscribe normalize the URL the same way (`assertPublicHttpsUrl` in both). Unsubscribe skipping DNS does not change the id.
- Without the `mcp` field, the REST delivery body and headers are byte-for-byte unchanged in `send()`.
- A `job_id` filter matches `multix.asset.ready` as well (`resource.id` is the job id, `job-events.ts:54`).
- Secrets never appear in views, logs or errors. Verification failures report only a category.

## Resolution

- M1: the dashboard removes the client's subscriptions before revoking the grant, ignoring the grant being revoked when it looks for another grant of the same client. If the removal fails, the grant stays, so the connection is still listed and the user can retry. Covered by a test where the removal fails once and a retry succeeds.
- M2: `removeByClient` first writes a `revoked:<clientId>` fence. `upsertMcpSubscription` refuses that client for `REVOKED_CLIENT_FENCE_MS` (10 minutes) with `client_revoked`, which `events/subscribe` answers with `-32600`. Housekeeping drops old fences. The window covers a subscribe that is verifying its callback during the revoke, and a token still served from an edge cache.
- M3: `SubscriptionView` gains optional `source: "mcp"` and `job_id`. The OpenAPI schema and descriptions, and the REST guide in both languages, are updated.
- L1: `upsertMcpSubscription` takes `reusesVerification` and returns `needs_verification` when the record is no longer live with the same callback and secret. The handler then verifies and writes again.
- L2: the dead-letter guard and the refresh both check liveness instead of status. A delivery that falls due after expiry is dead-lettered as "subscription expired" and no longer counts toward disabling.
- L3: expired or disabled MCP records are dropped after `MCP_RECORD_RETENTION_MS` (1 day).
- L4: the docs now say "created or last refreshed".
- L5: the revoke resolves the binding as `deps.events ?? env.MULTIX_EVENTS`.
- Test gaps: hub unit tests now cover the source and job view, revival with a new verification, the limit with an expired record, the end of the rotation window, mixed REST and MCP envelopes, the fence, expiry dead letters and MCP retention. OAuth tests cover a revoke that keeps another client's subscriptions and a revoke whose removal fails. The "another grant for the same client" case cannot be reached with the current OAuth library, because re-authorizing replaces the grant, so it stays a defensive check.
