# ADR 001: Usage ledger in a per-account SQLite Durable Object

Status: accepted (2026-10-26)

## Context
The FinOps dashboard needs filtered, paginated, aggregated reads over usage
events, budgets and activities, plus atomic budget reservations across
concurrent jobs. ACCOUNTS_KV cannot list or aggregate reliably (eventually
consistent, no secondary indexes). The candidates were D1 and a SQLite-backed
Durable Object (DO).

## Decision
One `AccountUsage` DO per account (`MULTIX_USAGE.getByName(userId)`), SQLite
storage, same pattern as `AccountEvents` and `AccountJobQuota`.

## Reasons
- Isolation by construction: an account's data lives in its own database;
  no query can read another account's rows, so a missing `WHERE account_id`
  cannot leak.
- Atomic reservations: a DO runs one request at a time and synchronous SQL
  between awaits cannot interleave, so check-and-reserve is race free without
  distributed locks. D1 would need conditional writes per budget.
- Scale fits: write rate per account is bounded by the job caps (2 concurrent
  jobs by default). A heavy account produces well under 100k events a year;
  indexed GROUP BY over that is milliseconds (perf test in
  `usage-ledger.test.ts`), so rollups are computed on read from indexed
  `started_at` instead of a second, drift-prone rollup table.
- No new binding type or migration tool: declarative DO `exports` already
  used by this Worker.

## Consequences
- Cross-account reporting (operator view) would need fan-out; not a goal.
- Schema migrations run inside the DO on first use (`user_version` pragma),
  forward-only and additive; rollback of the Worker leaves extra columns
  unused.
- Retention: events and activities older than 400 days are pruned by a daily
  alarm; export (CSV/JSON) and full deletion are available to the account.
