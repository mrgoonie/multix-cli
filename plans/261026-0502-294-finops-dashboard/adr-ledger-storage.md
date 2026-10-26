# ADR: usage ledger storage (issue #294)

Status: accepted, 2026-10-26

## Context

The Worker needs a per-account record of every operation (MCP job, REST job,
imported CLI history entry) with costs, tokens, credits, timings and outcome,
plus budgets and an activity history. Requirements from #294:

- Tenant isolation: one account never reads another account's rows.
- Idempotent writes: a relay replayed after a crash must not double-count.
- Unknown measurements stay `null`, never `0`.
- Summaries over up to 400 days, grouped by provider, model, command, source,
  client or day, fast enough to render on every dashboard visit.
- Retention, export and full deletion on request.
- No secrets, prompts, argv, cwd or signed URLs stored.

## Options

| Option | Isolation | Queries | Writes | Verdict |
|---|---|---|---|---|
| D1 (one shared database) | by `account_id` column in every query; one missed predicate leaks | SQL | one database for all accounts, global write throughput | rejected |
| KV | key prefix | no aggregation; summaries need full scans | eventually consistent, no transactions | rejected |
| Analytics Engine | by blob index | SQL-ish, sampled | append only, no idempotency, no deletion | rejected |
| SQLite Durable Object per account | by object name: the account's data lives in its own database | SQL with indexes | single writer, synchronous transactions | **chosen** |

## Decision

`AccountLedger` (`worker/src/ledger/account-ledger.ts`), a SQLite-backed
Durable Object named by account id (`MULTIX_LEDGER.getByName(userId)`), wraps
the runtime-neutral `UsageLedger` (`worker/src/ledger/usage-ledger.ts`), which
talks to SQL through a two-method `SqlPort`. Tests run the same class on
`node:sqlite`.

- **Schema versioning.** `ledger_meta.schema_version`, migrations applied in
  order inside one transaction at construction. `LEDGER_SCHEMA_VERSION = 1`.
- **Idempotency.** `op_id` is the primary key: `job_<jobId>` for jobs,
  `cli_<historyId>` for imports. A start record never overwrites a final one;
  the first final record wins and later ones report `duplicate`.
- **Delivery.** The job Durable Object stores the final ledger record in the
  same storage write as the job's final view (`ledger-outbox:<op_id>`), then a
  scheduled relay hands it to `AccountLedger.recordFinish` with retries, the
  same outbox used for job events. The start record is best effort.
- **Unknown values.** Every measurement column is nullable; summaries report
  `known_cost_usd` together with the count of operations whose cost is
  unknown, so a partial total is never shown as a full one.
- **Corrections.** Costs are never edited in place; `adjustments` rows
  (refund, correction, billed) reference the operation and count in totals.
- **Activities.** Append-only, hash-chained (`hash = sha256(prev_hash ||
  canonical row)`), so `verifyActivities` detects edited or removed rows.
- **Budgets.** Soft budgets (alerts at 50/80/100 % and a linear forecast);
  at most 20 per account.
- **Retention.** A daily alarm prunes operations, adjustments and activities
  older than 400 days. `deleteAllData` drops every operation,
  adjustment, alert and activity (budget definitions stay) and records one
  `ledger.deleted` activity as the new chain head.
- **Bounds.** Page size ≤ 200, export ≤ 10 000 rows, import ≤ 200 entries and
  512 KiB per request.

## Rollout

The `AccountLedger` class and its `MULTIX_LEDGER` binding ship in the same
deploy (new class, `exports` entry with `storage: "sqlite"`). The job
container image needs no change to keep working: usage and timings in job
results are optional, and the Worker reads them only when present. Jobs
started before the deploy carry no ledger metadata and are not recorded.
Rolling the Worker back leaves the ledger objects in place, unused.

## Consequences

- Cross-account reporting (an operator view of all accounts) needs a separate
  aggregate; out of scope.
- Hard budget enforcement (atomic reservation before a job starts) and
  rate-table cost estimates belong to #295; provider balance sync is #312.
