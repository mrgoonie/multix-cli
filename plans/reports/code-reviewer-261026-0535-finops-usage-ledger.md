# Code review: per-account usage ledger, FinOps dashboard, `multix history push` (#294)

Branch `claude/gracious-heisenberg-fdjdi4` vs `origin/main` (`git diff origin/main...HEAD`, docs-site/ excluded).
Date 2026-10-26 (UTC). Reviewer had no part in writing the code.

## Scope

- 63 files, about 8.7k added lines (about 3.4k of them tests). The core is in `worker/src/ledger/*`, `worker/src/jobs/{multix-job-container,job-runner,job-store}.ts`, `worker/container/{job-usage,job-runner}.mjs`, `worker/src/api/{usage-api-handlers,api-router}.ts`, `worker/src/routes/finops-dashboard-routes.ts`, `worker/src/pages/*` and `src/commands/agent/history-push.ts`.
- Checks run: `npm run check:mcp` (worker typecheck, all worker tests, bundle check), `npm run lint`, root `npm run typecheck`, and `tests/unit/commands/history-push.test.ts`. **All pass.**
- Probe tests (scratchpad only, not committed) ran against `UsageLedger` on node:sqlite to confirm findings M2, M3, L1, L3, L4 and L6 below.

## Overall assessment

The trust boundaries are solid:
- **Tenant isolation:** every path keys the ledger Durable Object by the authenticated account id. REST uses `caller.account.id`, the dashboard uses `signedInSession().account.id`, MCP uses `account.id`, and the job DO uses `slot.userId`, which the Worker writes at start.
- **CSRF and session:** dashboard POSTs go through `handlePost`, which checks Origin, then the session, then CSRF before `handleFinopsPost`.
- **SQL:** all values are bound. Dynamic SQL only uses fixed column maps (`GROUP_COLUMN`, `BUDGET_SCOPE_COLUMN`) keyed by validated enums.
- **XSS and CSV injection:** pages escape every value. CSV cells are formula-guarded, and validation regexes make string columns start with an alphanumeric anyway.
- **Container and Worker compatibility:** works in both directions. `usage` and `timings` are optional. The client payload in `job-runner.ts` whitelists fields, so an older Worker ignores them, and a newer Worker with an older container records nulls.
- **Idempotency:** holds (op_id primary key, first final record wins, outbox replay reports a duplicate).

No blockers. The defects are in accounting semantics, audit-log trust and cost at scale.

## Critical issues

None.

## High priority

None verified.

## Medium priority

### M1. Container-capacity rejections are recorded as failed operations, so retries inflate the failure count
- `worker/src/jobs/job-controller.ts:101-107`: `ContainerCapacityError` calls `finish(view, "failed", SERVER_AT_CAPACITY_ERROR)`, which calls `saveFinal`.
- `worker/src/jobs/multix-job-container.ts:81-90`: `saveFinal` writes a `ledger-outbox:job_<id>` record and schedules the relay.
- `worker/src/jobs/job-runner.ts:182-189`: the Worker then also calls `recordStart` and throws `JobCapacityError`, so the caller gets 429 `busy` and never gets a job id.

**Scenario:** the server is at `max_instances`. An MCP client retries `multix_run` 10 times. The ledger gains 10 `failed` operations (`error_code` `JOB_FAILED`), 10 `job.failed` activities and 10 rows in "Recent failures" for jobs the user never got. Success rate and failure counts are wrong.

**Fix:** in `saveFinal`, skip the ledger record when `view.error === SERVER_AT_CAPACITY_ERROR`. Alternatively, record it with a distinct status or `error_code` (e.g. `SERVER_BUSY`) and leave it out of `failed` and `success_rate`. Add a test using `fake-job-bindings.ts` at capacity.

### M2. Any API key can erase the whole activity log, and the integrity check then reports "intact"
- `worker/src/api/usage-api-handlers.ts:184-198` (`DELETE /api/v1/usage/data?confirm=delete`) calls `UsageLedger.deleteAllData` (`worker/src/ledger/usage-ledger.ts:986-993`), which deletes `activities` too.
- Confirmed by probe: after `deleteAllData`, `verifyActivities()` returns `{ok:true, checked:1}`, and the only row left is `ledger.deleted` with empty metadata.

**Scenario:** a leaked API key does the following, then wipes the log:
- `PATCH /provider-keys`
- `PUT /storage` (redirects outputs to an attacker bucket)
- `POST /events/subscriptions`

`provider_key.saved`, `storage.updated` and `webhook.subscribed` are all gone. The dashboard says "Integrity check passed … the chain is intact".

The ADR chose to drop activities on deletion. This is a product decision, so it is not reversed here; these are the options:
- (a) Keep `activities` on usage deletion, and delete only operations, adjustments and alerts.
- (b) Allow full deletion only from a dashboard session, not from an API key.
- (c) At minimum, record the pre-deletion chain head hash and row counts in the `ledger.deleted` metadata, so the wipe is evident.

### M3. Reading a heavy ledger costs O(rows) work on every dashboard visit
- **Activity page:** `worker/src/routes/finops-dashboard-routes.ts:317` runs `verifyActivities()` on every `/dashboard/activity` load, including filter or page changes and requests that fail validation. It re-hashes every activity with the pure-JS SHA-256 (`usage-ledger.ts:941-961`).
  - Probe: 50k activities took 744 ms to verify on Node.
  - Every non-CLI job adds one activity (`recordFinish`, `usage-ledger.ts:408-415`). At 1,000 jobs per day with 400-day retention that is about 400k rows, roughly 6 s of CPU and 400k rows read per page view.
  - The same applies to `GET /api/v1/activities/verify`.
- **Grouped summaries:** `summary()` with `group_by` (`usage-ledger.ts:627-645`) runs `totals()` per group, and each `totals()` runs 2 queries plus 2 percentiles × 2 queries. Probe: **309 SQL statements** for one grouped summary with 50 groups. Each statement scans the 400-day range, and the percentile `ORDER BY duration_ms OFFSET` has no index. The dashboard Usage page and `multix_usage_summary` both use this.
- **Impact:** Durable Object CPU limit and rows-read billing grow linearly with account activity.
- **Fix:**
  - Activity page: verify on demand (button or API), or verify incrementally from a stored checkpoint (`last_verified_seq`, `last_verified_hash` in `ledger_meta`).
  - Grouped summaries: compute group totals in one `GROUP BY` query (adjustments via a `LEFT JOIN` aggregated per op), and compute percentiles only for the totals, or for the top N groups shown.

## Low priority

### L1. Running jobs count as "unknown cost", which disables cost-per-output while any job runs
`usage-ledger.ts:552` counts `KNOWN_COST IS NULL` including `status='running'`, while `budgetStatus` (`:786`) excludes running.

Probe:
- One succeeded op with cost: `unknown_cost_operations = 0`, `cost_per_successful_output_usd = 1`.
- After one `recordStart`: `1` and `null`.
- The budget for the same data reports `0` unknown.

The overview KPI then warns "known cost above may be low" whenever a job is in flight.

**Fix:** add `AND status != 'running'` to `unknown_cost` in `totals()` and the series query, matching `budgetStatus`.

### L2. Operations can stay `running` forever
The finish record is written only in `saveFinal`, and there are two ways it never arrives:
- `expireJob` (`multix-job-container.ts:227-231`) deletes a job still in `starting` without a final record. That happens after a DO reset mid-start when nobody calls status: `job-controller.ts:123` gives up only inside `status()`.
- `relayOutbox` gives up after `RELAY_ATTEMPTS` (`event-outbox.ts:51-55`).

The ledger has no reconciliation, so the row counts as `running` and as unknown cost until the 400-day prune.

**Fix:** in `expireJob`, when the view is not terminal, write a `failed`/`timed_out` final record through `recordFinish`. And/or mark `running` rows older than the 35-minute job deadline as `timed_out` during the daily ledger alarm.

### L3. A huge numeric `from`/`to` produces a 500
`parseTime` (`worker/src/ledger/ledger-query.ts:33`) accepts any 1-16 digit epoch, but `Date` only goes up to 8.64e15.

Probe: `GET /usage/export?to=9000000000000000` makes `day(filter.to)` (`usage-api-handlers.ts:46,147`) throw `RangeError`, which `errorResponse` maps to 500 `internal`.
- In the dashboard, `isoDay()` throws the same way in `showUsage` (`finops-dashboard-routes.ts:204`) and `exportUsage` (`:229`).
- `errorMessage()` rethrows anything that is not a `LedgerQueryError`.
- On the export path the export has already been logged as an activity.

**Fix:** reject values above 8.64e15 (better: outside a sane window such as 2000-01-01 to now + 1 year) with a `LedgerQueryError`.

### L4. Import accepts any timestamp and any cost size
`importRecord` (`worker/src/ledger/ledger-records.ts:265`) takes any parseable `ts`, and `count()` (`:54`) any finite non-negative cost.

Probe:
- `ts: "2199-01-01"` with `cost_usd: 1e300` is accepted. It is never pruned and lands in future budget periods.
- `ts: "1900-01-01"` is accepted, reported as `accepted`, then silently pruned by the next alarm.
- Negative `started_at` values produce a `next_cursor` (`-2208988800000~…`) that the cursor regexes reject, which breaks paging.

The account can only harm its own ledger, but the totals become meaningless.

**Fix:**
- Reject entries outside [now − retention, now + 1 day] (count them as `rejected`).
- Cap `cost_usd`, e.g. at `MAX_ADJUSTMENT_USD`.

### L5. No per-account bound on ledger rows
Import allows 200 entries per request under the shared 60 requests/min limiter, i.e. up to 12k new rows per minute per key. Adjustments have no per-op cap. Nothing limits total operations or activities per account except DO storage, which feeds M3 (rows read) and operator storage cost.

**Fix:** a per-account cap on operations and activities (refuse import with 409 `limit_reached` beyond it), and a per-op adjustment cap, e.g. 50.

### L6. Budget alerts survive edits to scope, limit or period
`updateBudget` (`usage-ledger.ts:720-735`) keeps `budget_alerts` rows keyed by `(budget_id, period_start, threshold)`.

Probe:
1. A budget on `provider:gemini` crosses 50 and 100 %.
2. It is edited to `provider:openai`.
3. openai then spends 200 % of the limit: state `exceeded`, `alerts [50,100]`, **0 new threshold activities**.

Changing the period from month to week also mixes `period_start` values.

**Fix:** delete the budget's `budget_alerts` when `scope_kind`, `scope_value`, `period` or `limit_usd` change (or when thresholds drop).

### L7. Cost of operations that cross a period boundary never alerts the earlier period
Cost is attributed by `started_at` (`budgetStatus`, `usage-ledger.ts:787`), but `evaluateBudgets` (`:830-858`) checks only the period containing `now`.

**Scenario:** a job starts 23:59 on the last day of the month and finishes at 00:05 with $50. The finished month crosses 100 % without an alert, and the new month never sees the cost. Imported CLI history from earlier periods behaves the same.

**Fix:** also evaluate the period containing the record's `started_at` (pass it into `evaluateBudgets`).

### L8. `credits` are summed across providers
`totals()` returns `SUM(credits)` (`usage-ledger.ts:553`), and every row has `credits_unit = "provider_credits"`, so Leonardo tokens, fal credits and other units are added together in the API's `totals.credits`.

**Fix:** report credits only within a provider group, or as an object keyed by provider. Otherwise document it as non-additive and drop it from the account totals.

### L9. Refund sign is not enforced
`postAdjustment` (`usage-api-handlers.ts:110-118`) accepts `{kind:"refund", amount_usd: 5}`, which raises cost, although `ledger-types.ts:103` says "a refund is negative".

**Fix:** require `amount_usd < 0` for `refund` (or negate it server-side), and document this in the OpenAPI schema.

## Nits

- **N1.** `OperationDetail.error` is never set (`grep` finds no writer). Trace "Error" always renders "—", and the overview's `op.detail?.error` fallback is dead. Either populate it from `view.error` (it is a short, fixed Worker message) or remove the field.
- **N2.** `history-push.ts:134` sends `duration_ms: … ?? 0` when the duration is unknown, and the server stores 0. This conflicts with the "unknown is null" rule and skews p50/p95. Omit the field instead (the server already maps a missing value to null).
- **N3.** The integrity notice ("the log was changed outside the ledger") overclaims:
  - The chain is not anchored, so removing the newest rows or any oldest prefix verifies as intact (probe confirmed).
  - Only code that already holds write access can change the rows.
  - Suggested wording: "no edited or reordered entries found".
- **N4.** The ADR mentions `billed` adjustments. `AdjustmentKind` only has `refund | correction`.
- **N5.** `usage.imported` is appended even when the whole batch is duplicates (`usage-ledger.ts:436`), so retried pushes add log noise.

## Edge cases found while scouting

- **Start and finish ordering:** `recordStart` runs after `backend.start`, and the relay is scheduled at 0 s, so either can arrive first. Both orders converge, because `recordStart` is a no-op once a row exists and `recordFinish` merges into the running row. Correct.
- **Nested transactions:** `durableSqlPort` joins nested transactions to the outer one, and an exception inside `appendActivity` or `evaluateBudgets` rolls back the operation write too. Correct.
- **Outbox prefixes:** `outbox:` and `ledger-outbox:` do not overlap in `storage.list({prefix})`. `expireJob` deletes both.
- **Container output names:** `job-usage.mjs` resolves output paths against the job dir, which matches `cwd: dir` in `job-runner.mjs:157`. Output names are dropped by the Worker's `cleanOutputs` anyway.
- **History file:** the CLI history now goes to `<job dir>/history.jsonl` (outside `out/`). It is never uploaded and is removed with the dir. Only the reduced report leaves the container.

## Verified non-issues

- **Tenant isolation:** REST, MCP, dashboard and the job DO relay all key the ledger by the authenticated or recorded account id. Unknown ids return 404 within the caller's own object.
- **SQL injection:** none. All user values are bound, and identifiers come from fixed maps.
- **XSS:** every page value goes through `escapeHtml`, `textOr`, `money` or `count`. The budget form action uses a server-generated id and is escaped. Query strings in links are escaped.
- **CSV:** `csvCell` guards `= + - @ \t \r` and quotes per RFC 4180. Times are ISO 8601. Unknown values are empty cells.
- **Secrets:** activities hold names and ids only. The webhook activity stores the callback hostname only. Logs carry error names, never values. Ledger rows hold no argv, prompts, cwd or URLs, and `matching()` rejects `//`.
- **CLI:** `MULTIX_API_KEY` and `MULTIX_REMOTE_URL` are excluded from project `.env`. `--url` requires https (http only on loopback) and rejects credentials, query or fragment.

## Recommended actions (priority order)

1. M1: skip or relabel ledger records for capacity rejections.
2. M2: product decision on whether usage deletion may erase the activity log via an API key; record the chain head in `ledger.deleted` in any case.
3. M3: move the activity verify off the page-load path (checkpointed or on demand), and collapse grouped summaries into one `GROUP BY`.
4. L1, L3, L4: small validation and semantics fixes, each with a unit test.
5. L2, L6, L7: reconciliation and budget-alert correctness.
6. L5, L8, L9, nits.

## Metrics

- Type coverage: strict TS, typecheck clean (root, worker, worker tests).
- Tests: the 5 new or changed ledger, API, dashboard and container suites pass (80 tests); `check:mcp` passes; CLI `history-push` passes (20 tests).
- Lint: 0 issues (biome, 536 files).

## Unresolved questions

- M2: is erasing the activity log through `DELETE /usage/data` with an API key intended, or should only usage rows go?
- M1: should a request that is rejected at capacity appear in the ledger at all (as `rejected`), or not at all?
