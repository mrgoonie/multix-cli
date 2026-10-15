# Code review: job event webhooks (commit 1ff86f3, issue #223)

## Scope
- Files: worker/src/events/*, worker/src/jobs/{multix-job-container,job-controller,job-store,job-runner}.ts, worker/src/api/{api-router,event-api-handlers,openapi-document,api-http}.ts, worker/wrangler.jsonc, tests
- LOC: +2431 / -20 (26 files)
- Checks run: `npx vitest run` (18 files, 228 tests pass), `npx tsc --noEmit` (clean), no `node:` imports in worker/src
- Library verified: @cloudflare/containers `schedule()` does the sync `INSERT` before its first await (dist/lib/container.js:799-835), so the put + schedule in `saveFinal` commit together. The Container `alarm()` catches callback errors and deletes the schedule row whatever the outcome (container.js:1530-1545).

## Overall assessment
The design holds up: an outbox inside the job DO, a per-account hub, dedupe by event id, signing, and a bounded queue. I traced the finish race, the input-gate reasoning in `updateSubscription`, cross-account isolation, the SSRF guard, and payload scrubbing, and they are sound. Two findings are high. Seen records grow without bound for every account that has no subscription. Revoke throws when more than 127 deliveries are queued. Three medium findings weaken the at-least-once and "no phantom events" story.

## High

### H1. `seen:` records grow forever on accounts with no subscription
- File: worker/src/events/event-hub.ts, `publish()` (`if (queued > 0) await this.ensureAlarm(now)`) and `scheduleNext()`.
- Failure path: the account has never subscribed. Each job finishes, `relayEvents` calls `publish`, and `publish` writes `seen:<eventId>` for 1 to 21 events per job. `queued` stays 0, so no alarm is ever set. `housekeep()` only runs from `alarm()`, so the records are never trimmed. This is the default state of every account.
- Second-order effect: if that account subscribes months later, `subscribe` sets the first alarm, and `housekeep()` then runs `storage.list({prefix:"seen:"})` with no limit. That loads every record ever written into a single alarm invocation. The CPU and memory risk sits on the path that also delivers the account's webhooks, and a throwing alarm is retried, which re-sends deliveries.
- Fix: skip `seen:` and the RPC entirely when no live subscription matches the event (dedupe only matters when a delivery is queued). Or call `ensureAlarm(now + HOUSEKEEPING_INTERVAL_MS)` whenever `publish` writes anything. Also page the `seen:` scan in `housekeep` (`limit` + `start`) so a large backlog cannot blow up a single alarm.

### H2. Revoke throws once a subscription has more than 127 queued deliveries
- File: worker/src/events/event-hub.ts, `unsubscribe()`: `await this.storage.delete(keys)` with `keys = [sub, ...all queued for it]`.
- `DurableObjectStorage.delete(string[])` accepts at most 128 keys; the code already acknowledges this in `housekeep`. The queue cap is 500 per account.
- Failure path: the endpoint is down for a few hours under normal use. With the default subscription to all events, a job with 12 stored outputs queues 13 deliveries, so about 10 jobs are enough. The user then calls `DELETE /events/subscriptions/{id}`. It returns 500 and nothing is deleted, because the whole call throws, sub record included. The user cannot stop deliveries to a URL they want gone, which is exactly the situation where revoke matters. The OpenAPI text promises "drops the ones still queued".
- Fix: delete the `sub:` key first in its own call, then delete the queued keys in chunks of 128. Deliveries already handle a missing sub by dropping themselves, so even a partial chunked delete is safe. Add a test with more than 128 queued deliveries, and make `fakeDoStorage.delete` and `put` throw above 128 keys so the fake matches production.

## Medium

### M1. Outbox relay gives up after about 85 minutes, and nothing re-drives it
- Files: worker/src/events/event-outbox.ts (`RELAY_ATTEMPTS = 10`; delays 10 s to 2560 s, about 5110 s in total); worker/src/jobs/multix-job-container.ts.
- Failure path: AccountEvents is unavailable or throwing for more than about 1.5 h (a bad deploy, or the H1 alarm blowup holding the DO). `relayOutbox` logs `event_relay_gave_up` and returns. The `outbox:` entries stay until `expireJob` deletes them 7 days later. No status read, poll or later job re-triggers the relay, so the events are lost. That contradicts "durable" and the documented "Delivery is at least once".
- The same applies when `port.list()` or the slot `get` throws inside `relayEvents`. The Container alarm swallows the error and deletes the schedule row, so no retry is scheduled.
- Fix: keep retrying at the 1 h cap until the retention ends, rather than stopping after a fixed count. Or re-schedule the relay from `jobStatus` or `expireJob` when outbox entries exist. Wrap the whole `relayEvents` body so any throw schedules the next attempt.

### M2. A capacity rejection emits a `multix.job.failed` webhook for a job the caller never received
- Files: worker/src/jobs/job-controller.ts `start()` -> `finish(view, "failed", SERVER_AT_CAPACITY_ERROR)` -> `saveFinal` (writes the outbox); worker/src/jobs/job-runner.ts:162 turns that view into `JobCapacityError` and returns no job id.
- Failure path: the server is at `max_instances`. Each `POST /api/v1/jobs` or `multix_run` retry by a client produces a job.failed webhook with a fresh unknown job id. Receivers that alert on job.failed get a flood during capacity incidents, and each one also takes a queue slot toward `MAX_QUEUED_DELIVERIES`.
- Fix: do not emit events when the error is `SERVER_AT_CAPACITY_ERROR`. For example, `saveFinal` could take an `emit` flag, or the controller could call plain `save` for that branch. Add a test for it.

### M3. Housekeeping is starved while 10 or more deliveries are due
- File: worker/src/events/event-hub.ts `alarm()`: `if (due.size >= DELIVERY_BATCH) { setAlarm(now); return; }` comes before `housekeep()`.
- Failure path: the endpoint is slow (10 s timeouts) during a burst, or the queue is full. Fresh dead letters ("delivery queue full") keep being written, but the trimming of `dead:`, `audit:` and `seen:` and the marking of expired subscriptions never run until the backlog clears. Delivery itself is still gated by `isLive`, so this is growth and stale status, not wrong delivery.
- Fix: run `housekeep()` on the continuation path too. It already throttles itself through `meta:housekept`.

## Low

- L1. Revoke during an in-flight retry recreates a queue entry. In `deliver()`, the retry branch `put`s a new `q:` entry after the fetch. If `unsubscribe` ran during the fetch (the input gate is open during fetch), that entry is orphaned. The next alarm drops it because the sub is missing, but it counts toward the 500 cap meanwhile. The dead-letter branch also writes a dead letter for the revoked subscription. The subscription itself is never resurrected, because `updateSubscription` returns when the record is gone. Fix: re-read `sub:` before writing the retry or dead-letter entry. The existing test only covers the success path.
- L2. `MAX_EVENT_BYTES` compares `JSON.stringify(event).length` (UTF-16 code units), not bytes. The `outputs` array in `multix.job.*` is not capped (the job server allows up to 50 files), so long or non-ASCII names can push job.completed past the limit, and it is dead-lettered as "event too large". Asset events stop silently at index 20 of up to 50. Fix: measure with `TextEncoder`, cap or truncate `outputs` in the event, and document the cap of 20 asset events.
- L3. The webhook secret is stored in plaintext in AccountEvents storage, while provider secrets are encrypted (`accounts/provider-secret-crypto.ts`). Only Worker code can read DO storage, so this is a consistency or defence-in-depth note, not an exposure.
- L4. Callback URLs that carry the secret in the path (Slack or Discord style) are returned unredacted by `GET /events/subscriptions`, because `redactUrl` strips only the query. This is limited to the owning account's API keys and is never logged. Document it or redact the path after the host.
- L5. The ownHost check only compares `app.origin`, so other hostnames of the same Worker (workers.dev, alternate routes) pass. The impact is unauthenticated POSTs to its own endpoints, which return 401. Negligible.
- L6. Docs: README.md, docs-site guides (EN and VI rest-api and mcp-server) and skill/SKILL.md are modified in the working tree but are not in commit 1ff86f3. Per AGENTS.md they must ship in the same PR.

## Verified non-issues (evidence)
- Double-finish race: `finish()` does `load`, then the slot `get`, then `put`, with only storage calls between them, so the input gate serialises concurrent finishes. Test job-controller.test.ts:269.
- Atomicity of `saveFinal`: `storage.put(writes)` is not awaited, and the sync SQL insert in `schedule()` runs in the same tick, so the writes coalesce into one commit.
- Cross-account access: the hub is always `getByName(caller.account.id)` (REST) or `slot.userId` (job DO). Subscription ids are scoped to each DO. Covered by rest-api.test.ts:341.
- SSRF: https only, default port, no IP literals or internal suffixes, `global_fetch_strictly_public` (wrangler.jsonc:16), `redirect: "manual"`.
- Payloads and logs: no prompts, error text, URLs or keys. Logs carry the event name and subscription id only.
- Bundle: no `node:` imports in worker/src. tsc is clean.
- Backward compatibility: `command` is optional in `SlotRecord` and `startJob`, so jobs started before the deploy emit events with an empty command or provider. The container image and protocol are unchanged.
- OpenAPI matches the router. Covered by rest-api.test.ts:421. Retry span is about 22.7 h, which matches "about a day".

## Test gaps
- No test of `MultixJobContainer.saveFinal` or `relayEvents` wiring: it is only exercised through the fake controller port.
- `fakeDoStorage` does not enforce the 128-key limit on `put` and `delete`, which hides H2.
- No test that an account with no subscription gets housekeeping (H1), none for a capacity failure emitting nothing (M2), and none for revoke during a retry (L1).
- The controller race test runs without input-gate semantics. It passes only because the race resolves before `load`.

## Recommended actions
1. H2: chunk the revoke delete, sub key first, and make the fake storage enforce 128 keys.
2. H1: skip `seen:` when nothing matches, or always arm the housekeeping alarm. Page the `seen:` scan.
3. M1: relay retries until retention, and wrap `relayEvents` fully.
4. M2: suppress events for capacity rejections.
5. M3: housekeep on the continuation path.
6. Commit the docs changes with the PR.

## Resolution (follow-up commit on the same branch)

- H1 fixed: an event no live subscription wants writes nothing; any stored dedupe record or dead letter now sets a housekeeping alarm; the `seen:` scan is paged.
- H2 fixed: revoke deletes the subscription key first, then queued deliveries in chunks of 128. The fake storage now enforces the 128-key limit.
- M1 fixed: relay retries hourly for the job's whole retention period, and a throw while reading the outbox schedules the next attempt.
- M2 fixed: capacity rejections (the caller never receives the job id) emit no events.
- M3 fixed: housekeeping runs (rate-limited) before the backlog early return.
- L1 fixed: after the request, a revoked subscription gets no retry or dead letter.
- L2 partly fixed: the size limit counts UTF-8 bytes. The 20 asset events per job are documented.
- L3, L4, L5 accepted: secrets live only in the account's own Durable Object storage, readable only by Worker code; full callback URLs are shown only to the owning account; other hostnames of the same Worker require authentication and answer 401.
- L6 fixed: docs committed on the branch.

Every new regression test fails without its fix and passes with it.
