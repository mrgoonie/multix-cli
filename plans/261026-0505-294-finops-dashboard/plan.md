# Plan: FinOps usage ledger, budgets, traces and activities (#294)

Status: in progress · Branch: `claude/gracious-heisenberg-24hbl4` · Issue: #294

## Outcome
`/dashboard` becomes a FinOps and observability console backed by a durable,
per-account usage ledger. Remote jobs (MCP and REST) are captured
automatically; CLI history is imported only on request. Budgets track and,
when set to block, reserve before a job starts.

## Constraints
- Unknown cost is `null`, never `0`. Provider-reported, estimated (rate card)
  and unknown are labelled separately.
- Tenant isolation: one Durable Object per account; no cross-account query path.
- No prompts, argv, stdout, output bodies, keys, bearer tokens or signed URLs
  in the ledger.
- Container/Worker compatibility both ways (AGENTS.md): new result fields are
  optional; a missing field means unknown.
- Dashboard stays server-rendered under the existing CSP (no new scripts).

## Non-goals
- A generic telemetry stack (Cloudflare Observability stays as is).
- Blocking spend made outside Multix (direct provider use, local CLI runs).

## Phases
1. ADR + ledger core (`worker/src/usage/`): schema, idempotent ingest,
   settlement, adjustments, queries, budgets, reservations, alerts,
   activities (hash chained), rate card, retention, export, deletion.
2. Capture: container returns `timings` and a redacted `run` summary from a
   job-local CLI history file; job DO relays a usage record through an
   outbox; JobRunner begins/reserves before start and releases on rejection.
3. Surfaces: REST (`/api/v1/usage…`, `/budgets…`, `/activities`,
   `/rate-card`, `/balances`), MCP `multix_usage` tool, dashboard tabs
   (Overview, Usage & Costs, Budgets, Traces, Activities, Settings).
4. CLI: `multix history sync` (opt-in import with dedup and redaction).
5. Docs (README, docs-site EN+VI, skill), tests, review, PR.

## Acceptance criteria
See the Definition of Done in #294; each item maps to tests in
`worker/test/usage-*.test.ts`, `worker/test/container-job-runner.test.ts`
and `tests/history-sync.test.ts`.
