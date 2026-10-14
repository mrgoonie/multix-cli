# Code review: PR #204 (slot release retry, #198) and PR #205 (unused import, #163)

Date: 2026-10-14 (Asia/Saigon). Reviewer did not write either change. No source files modified.

## Scope
- #204 `fix/mcp-job-slot-release-retry` @ e4dda40: `worker/src/jobs/job-controller.ts`, `worker/src/jobs/multix-job-container.ts`, `worker/test/job-controller.test.ts` (+66/-5 vs merge-base 3a446fc).
- #205 `test/smoke-unused-import` @ 6c59b55: `tests/smoke/cli.test.ts` (1 line).
- Library behavior checked against `worker/node_modules/@cloudflare/containers` 0.3.7 `dist/lib/container.js` (`schedule` ~799, `alarm` ~1502-1590).

## Verdict
- #204: approve. No critical/high defects. Two medium follow-ups (observability, DO wiring untested).
- #205: approve. Import confirmed unused.

## PR #204 findings

### Critical / High
None.

### Medium
1. **No signal when a release fails or retries run out** - `job-controller.ts:178-188`. Both catches are silent. A slot stuck for the 45-min lease (`JOB_SLOT_LEASE_MS`, `job-protocol.ts:85`) on `server:all` lowers capacity for every account and leaves nothing in Workers logs to explain "server at capacity". Suggest one `console.warn` on the final failed attempt and on a failed schedule (job id only, no user data). Note: `worker/src/jobs` has no logging today, so this is a convention choice, not a regression; the old code was equally silent.
2. **DO wiring is not covered by tests** - `multix-job-container.ts:81-83,110-112`. Tests drive `controller.releaseSlot(n)` directly with a fake port. Nothing proves the string `"retrySlotRelease"` matches the method or that the payload reaches it as `attempt`. A future rename would make `this.schedule` throw `this.retrySlotRelease is not a function` (container.js ~806), which the inner catch at `job-controller.ts:184-186` swallows, so retries would silently stop. Cheap fix: type the name (`"retrySlotRelease" satisfies keyof MultixJobContainer`), or a small test that stubs `schedule` and checks callback name + payload. Same latent issue exists for `"pollJob"`/`"expireJob"`.

### Low / informational
3. **Branch is one commit behind main.** `git diff origin/main..HEAD` (two-dot) shows `tests/unit/providers/atlascloud/prediction-runner.test.ts` losing the 30 s timeout from #193. That is a stale-base artifact, not part of the PR: merge-base diff and `gh pr view 204` list only the 3 worker files, and GitHub reports MERGEABLE. A merge keeps #193's change. Rebasing is optional.
4. **Duplicate retry chains are possible but harmless.** `finish()` has no terminal guard and can run more than once concurrently (status RPC, poll alarm, onStop interleave across the `fetchContainer` await). Each run can start its own retry chain (at most 4 schedules each). Release is idempotent per jobId (`account-job-quota.ts:84-89`, `Promise.all` on account + server), so double or partial releases are safe. This was already the case before the PR.
5. **Retry window (30+60+90+120 = 300 s) is much shorter than the 45-min lease.** If the quota DO is down for more than 5 min, the lease takes over, as documented. Acceptable. A longer last delay could cover more of the lease at no cost, but this is optional.
6. `retrySlotRelease` is a public DO method, so it can be called over RPC. It has the same exposure as the existing `pollJob`/`expireJob`. Only the Worker holds stubs and it never forwards outside requests, and a call can only re-release this job's own slot. No action needed.

### Checklist items requested
- **Retry/backoff:** correct. With attempt n failing and n < 5, it schedules n+1 after 30·n s. Attempt 5 does not schedule. So 5 tries in total, which matches `SLOT_RELEASE_ATTEMPTS`. The test asserts `[2,3,4,5]` / `[30,60,90,120]`.
- **Schedule name/payload:** correct. The library stores `JSON.stringify(attempt)` and calls `callback.call(this, payload, schedule)` (container.js ~1541-1543), so `attempt` arrives as the first argument. `when` is a number, so this is a delayed schedule.
- **Runs after `destroy()`:** yes. When the container is not running, `alarm()` re-arms with `setAlarm(minTimeFromSchedules)` (~1556-1563), so retries still fire after `finish()` destroys the container. Schedules are stored in DO SQLite, so they survive eviction.
- **Interaction with `expireJob`:** safe. Retention is 7 days (`job-protocol.ts:90`) against a 5-minute retry window, so the two cannot overlap in practice. If a retry ever ran after expiry, `releaseSlot` would read no `SLOT_KEY` and do nothing (`multix-job-container.ts:76-79`), with no error and no rescheduling. `expireJob` deletes only `[JOB_KEY, SLOT_KEY]`, not the schedules table.
- **Idempotency:** confirmed. `AccountJobQuota.release` returns early when the jobId is absent.
- **Callback errors:** `retrySlotRelease` never throws, because `releaseSlot` catches everything. The library deletes the run row after the callback runs, and a rescheduled retry gets a new row id, so the chain keeps going.

### Verification
- `npm run lint`: clean (397 files).
- `npm run check:mcp`: worker typecheck OK, 14 files / 177 tests pass, wrangler dry-run OK, bundle check clean.
- `vitest worker/test/job-controller.test.ts`: 9/9 pass.

## PR #205 findings
- `beforeAll` appears once on origin/main (the import only) and 0 times after the change. It is unused, so the removal is correct.
- Commit type is `test(smoke)`, so no npm release is triggered (correct). The branch prefix `test/` is not in the AGENTS.md list (`feat/fix/docs/chore`). This is trivial and not blocking.
- The worktree has no `node_modules`, so `npm run lint` / `npm run typecheck` were **not run there**. As a substitute, Biome from the #204 worktree ran on the file: clean. Removing an unreferenced import cannot introduce a type error. CI should confirm typecheck.

## Recommended actions
1. (#204, optional before merge) Add a typed callback name or a wiring test for `retrySlotRelease`.
2. (#204, follow-up OK) Log exhausted or unschedulable slot releases.
3. Merge #205 as is.

Status: DONE
Summary: #204 retry logic, schedule payload, post-destroy firing, expiry interaction and idempotency all check out; lint and check:mcp are green. #205 is correct; its local lint/typecheck were not run (no node_modules), and Biome via the sibling worktree is clean.
Concerns/Blockers: none blocking. Medium: silent failure path with no logs, and the schedule callback name is untyped and untested.

## Unresolved questions
- Should a slot release that still fails after all retries be logged/alerted, given that `worker/src/jobs` has no logging today?
- Is 5 min of retries intended, or should the backoff reach closer to the 45-min lease?
