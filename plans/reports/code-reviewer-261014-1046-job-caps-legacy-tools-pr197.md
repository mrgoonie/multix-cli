# Code review: PR #197 — configurable job caps + drop legacy MCP tools

Branch `feat/mcp-job-caps-drop-legacy-tools`, `git diff origin/main...HEAD` (99b1b4d feat, a2da416 docs). Reviewer did not write the code. 2026-10-14 10:46 (Asia/Saigon).

## Scope
- 26 files, +406 / -3578. Core: `worker/src/jobs/account-job-quota.ts`, `worker/src/config.ts`, `job-runner.ts`, `job-tools.ts`, `index.ts`, `mcp-api-handler.ts`, `mcp-server.ts`, `wrangler.jsonc`; deleted `worker/src/providers/*`, `live-smoke.test.ts`, atlas fixture; docs (README, docs-site EN+VI, skill/SKILL.md).
- Also read: `multix-job-container.ts` (releaseSlot), `job-controller.ts` (finish/start), `job-protocol.ts` (lease constants), `account-store.ts` (account id format), `job-tools-oauth.test.ts`.

## Verification
- `npm run lint`: clean (386 files).
- `npm run check:mcp`: worker typecheck OK, 13 files / 162 tests pass, bundle check clean.
- `npm run verify:docs`: 7/7 pass.
- Stale-reference grep (ALLOWED_PROVIDERS/MODELS, MAX_PROMPT_CHARS, IMAGE_WAIT, multix_list_providers, generate_image/video, prediction_status, worker/src/providers, live-smoke, ACCOUNT_BUSY_ERROR, atlas fixture) in tracked files outside `plans/` and root `src/`: no hits. `wrangler.jsonc` vars match `WorkerEnv`.

## Overall
Two-level acquire is correct for the normal "server full" path (account slot rolled back, tested). Release is idempotent and safe for jobs from the previous deploy that hold only an account slot (server `release` is a no-op when the id is absent). RPC signature `acquire(jobId, limit = 2)` is backward compatible for callers without `limit`. Weak spots: the exception path of the server acquire, and amplified blast radius of a lost release now that slots are global. No Critical/High findings.

## Critical
None.

## High
None.

## Medium

### M1. Server slot leaks for ~45 min when the server-slot RPC throws after committing
`worker/src/jobs/account-job-quota.ts:116-123` (durableJobQuota.acquire)
```ts
let taken = false;
try {
  taken = await server().acquire(jobId, caps.total);
} finally {
  if (!taken) await account.release(jobId).catch(() => undefined);
}
```
Scenario: `server:all` DO writes the slot (`storage.put`) then the RPC rejects to the caller (DO reset on deploy — every deploy resets DOs —, overload, network blip). `taken` stays false, account slot is rolled back, the exception propagates out of `JobRunner.run` (acquire sits outside its try, `job-runner.ts:139`), but the server slot remains for `JOB_SLOT_LEASE_MS` (45 min). With default `MULTIX_MAX_JOBS_TOTAL=10`, a handful of these during a deploy burst cuts global capacity for every account for 45 min.
Fix: on any non-`ok` outcome release both, best-effort; release is idempotent and a no-op when absent:
```ts
} finally {
  if (!taken) {
    await Promise.allSettled([account.release(jobId), server().release(jobId)]);
  }
}
```
Add a test where the server stub's `acquire` writes then throws, asserting both sets are empty afterwards.

### M2. A lost release now blocks a global slot, not just the owner's account
`worker/src/jobs/multix-job-container.ts:76-80`, `worker/src/jobs/job-controller.ts:176-180`
`finish()` swallows `releaseSlot` errors ("lease expires on its own"). Before this PR the cost was one account blocked for ≤45 min; now the same failure also pins one of the `MULTIX_MAX_JOBS_TOTAL` server slots, so the cost lands on all users. `release` now does two RPCs via `Promise.all`, doubling the failure surface; all job completions also funnel through one hot DO (`server:all`), so a transient issue there hits many releases at once.
Fix (pick one): retry on failure via the existing scheduler (`this.schedule(30, "retryRelease")` that re-reads `SLOT_KEY` and calls release, bounded attempts), or retry once inside `releaseSlot` with `Promise.allSettled` so one failing side does not skip the other's retry. Optionally shorten the server lease relative to account lease is NOT recommended (live jobs would lose slots); retrying is the right fix.

## Low

### L1. In-flight jobs from the previous deploy are invisible to the server cap
`account-job-quota.ts` (design). Jobs started before this deploy hold only an account slot, so for up to ~35 min after deploy the Worker can admit `MULTIX_MAX_JOBS_TOTAL` new jobs on top of them. Bounded by container `max_instances`: excess fails as `ContainerCapacityError` -> `SERVER_AT_CAPACITY_ERROR`, and `finish()` releases both slots. Self-healing; acceptable. Mention in PR description/deploy notes rather than code.

### L2. `MULTIX_MAX_JOBS_TOTAL` can exceed `max_instances` silently
`worker/src/config.ts:158-167`, `wrangler.jsonc:56,79`. Ceiling 1000 vs `max_instances: 10`. If an operator sets 20, the Worker cap stops protecting anything and users get platform capacity failures instead (same message). Runtime cannot read `max_instances`; docs already say "keep at or below". Optionally log a warn once when `total > 10` default... or add a comment check in `check:bundle`/a unit test that parses `wrangler.jsonc` and asserts `MULTIX_MAX_JOBS_TOTAL <= max_instances` for the shipped config.

### L3. `multix_catalog` description promises `multix_run` when it is not registered
`worker/src/jobs/job-tools.ts:47-48`. Catalog is now always registered; without job bindings its description still says "commands this server can run with multix_run" and points callers at a missing tool. Fix: pick the description by `jobs !== undefined`, e.g. append "multix_run is not available on this server" when absent.

### L4. `multix_run` description mentions only the per-account cap
`job-tools.ts:71`. Server-wide cap (`jobs.caps.total`) is not surfaced; agents get `server at capacity` without prior hint. Add "server runs at most N jobs at once" or leave as is (docs cover it). Also `SERVER_AT_CAPACITY_ERROR` text ("every job container is in use", `job-protocol.ts:87-88`) is now also returned when the configurable cap, not containers, is exhausted; wording is slightly inaccurate but harmless.

### L5. Test gaps
- No test for the server-acquire exception path (M1).
- No test that `MultixJobContainer.releaseSlot` frees the server slot; only `durableJobQuota.release` is covered indirectly (`account-job-quota.test.ts` "release gh-2 b, then gh-3 d ok").
- No wiring test that `MULTIX_MAX_JOBS_*` vars reach `durableJobQuota` through `index.ts` (OAuth test uses defaults). `jobCapsFrom` is unit-tested in isolation; `index.ts:85,93-94` passes the same `caps` to quota and message, so drift risk is low.
- Legacy-tool coverage deleted along with the tools; key-forwarding coverage still exists in `job-tools-oauth.test.ts:74-101` (asserts spec env gets the account's key, output redacted). OK.

### L6. Breaking change for hosted MCP clients
Five tools removed from the hosted server (multix.zuey.me). Clients/agents with saved tool calls (`multix_generate_image`, etc.) now get "unknown tool". Worker is not on npm, so `feat` without `!` is defensible, but note: this `feat` commit triggers an npm CLI release with no CLI change. Call out the removal in the PR body / release notes for hosted users.

### L7. Stale comment
`worker/src/app-context.ts:18`: "defaults to the Worker's fetch (GitHub and provider calls)" — the Worker no longer makes provider calls. Trivial.

### L8. Mixed-version window and `limit`
`account-job-quota.ts:72`. If a new Worker ever talks to an old-code `AccountJobQuota` instance, `limit` is ignored and `server:all` caps at 2. Standard `wrangler deploy` resets DOs to new code, so not expected; only matters if gradual deployments (`versions upload`) are adopted. No repo evidence of gradual deploys.

## Edge cases checked (OK)
- Idempotent acquire for same jobId (`takeSlot` returns ok when present); jobIds are fresh UUIDs.
- Release idempotent/no-op when absent (old jobs, expired leases, repeated finish).
- `SERVER_SLOTS_NAME="server:all"` cannot collide: account ids are `gh-<numeric>` (`account-store.ts:73`).
- Lowering caps while jobs run: `takeSlot` counts live leases, so new acquires refuse until below the new cap. Correct.
- Concurrent acquire on same account during server-busy rollback can see a transient false `account-busy`; acceptable.
- `boundedInt`: "0", negative, non-integer, empty -> default; above ceiling -> clamped. Tested.
- Docs: defaults (2/10), ceilings (50/1000), 45-min lease (`JOB_GIVE_UP_MS` 35m + 10m), wait 25/40, error texts, "only multix_catalog without bindings" — all match code. VI doc mirrors EN for the new sections.

## Recommended actions
1. M1: release both slots on any failed acquire; add throwing-stub test.
2. M2: retry release in the job DO (scheduled retry) so one transient failure does not pin a global slot for 45 min.
3. L3/L4: conditional catalog description; mention the server cap in `multix_run` description.
4. L6: note tool removal in PR/release notes.

## Metrics
- Type coverage: worker typecheck clean.
- Tests: 162/162 worker; coverage % not measured.
- Lint issues: 0.

## Unresolved questions
1. Does production deploy use plain `wrangler deploy` or gradual versions? Affects L8.
2. Is announcing the removal of the five legacy tools to hosted users planned (L6)?
3. Should the server-wide cap be enforced even when `MULTIX_JOB_QUOTA` is the only DO available but `MULTIX_JOBS` missing? Currently irrelevant (tools not registered), just confirming intent.
