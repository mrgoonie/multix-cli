# FinOps dashboard: usage ledger, budgets, traces, activities (issue #294)

Status: implemented, in review

## Outcome

- Every MCP and REST job is recorded in a per-account usage ledger with
  costs, tokens, credits, timings, outputs and outcome; unknown is `null`.
- CLI users can opt in to upload redacted local history (`multix history push`).
- Soft budgets per account, provider, model or command with 50/80/100 %
  alerts and a forecast.
- Dashboard tabs: Overview, Usage & costs, Budgets, Traces, Activity, with
  filters, CSV/JSON export and deletion.
- REST `/api/v1/usage/*`, `/budgets`, `/activities`; MCP tool
  `multix_usage_summary`.

## Constraints and non-goals

- No prompts, argv, cwd, signed URLs or secrets in the ledger.
- Container stays compatible with the live Worker in both directions.
- Non-goals: atomic budget reservation, hard enforcement and rate-table
  cost estimates (#295); provider balance sync (#312).

## Design

See [adr-ledger-storage.md](adr-ledger-storage.md).

## Files

- `worker/src/ledger/*` (new): types, ledger, Durable Object, records, query.
- `worker/src/jobs/*`: ledger metadata through start, outbox in the job DO.
- `worker/container/job-usage.mjs`: optional usage and timings in results.
- `worker/src/api/*`, `mcp-*.ts`: REST and MCP surfaces.
- `worker/src/routes/*`, `pages/*`: dashboard.
- `src/commands/agent/history-push.ts`: CLI opt-in import.

## Validation

- Worker: `npm run typecheck`, `npx vitest run`, `npx biome check`.
- Root: `npm run lint`, `typecheck`, `build`, `test`, `check:mcp`,
  `verify:docs`.
