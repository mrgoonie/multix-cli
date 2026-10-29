# Code review: commit 1a482ce, count a task's credits once per operation (#424)

Date: 2026-10-29 (UTC). Branch `claude/gracious-heisenberg-vydm37`, based on `origin/dev`.
Reviewer: isolated code-reviewer. I did not write this code and did not modify any source file.

## Scope

- Files: `src/budget/cost-receipt.ts`, `src/catalog/usage-aggregate.ts`,
  `src/commands/agent/history-command.ts`, 3 unit test files, 4 docs-site pages (EN + VI).
- LOC: +132 / -10.
- Context I read: `summarizeUsage` / `jobIdentity` (`src/agent/run-state.ts`),
  `costReceiptFor` (`src/agent/cost-preflight.ts`), finalize in `src/agent/agent-runtime.ts`,
  id and credit extraction (`src/core/usage-extract.ts`, `src/agent/fetch-telemetry.ts`),
  Runway and Leonardo types, `AGENTS.md`, and issue #424 (via REST). There is no `REVIEW.md` at the repo root.

## Verification

- `npm run typecheck`: clean.
- `biome check` on the 6 changed TS files: clean.
- `vitest run tests/unit/budget tests/unit/catalog tests/unit/agent`: 17 files, 310 tests, all pass.
- Throwaway probe (written to a temp test file and deleted afterwards; the tree is clean). Results:
  - P1: one op id, two charge runs (10 credits each), then a status read (10): `total_credits = 10`.
  - P2: an op known only from a status read (7 credits): `total_credits = 7`, `operations = []`.
  - P3: a submit with `model_resolved: "m1"` plus a status run of the same op with `model_resolved: null`:
    - `aggregateUsage(..., "offering")` returns `[["x:(unknown model)",40],["x:m1",40]]`.
    - `historyStats(..., "command")` returns `[["x video",40],["x status",40]]`.
    - `historyStats(..., "provider")` returns `[["x",40]]`.
  - P4: an entry whose receipt is `refused` and has `usage.credits: 5` shows no `credits` key.

## Overall assessment

The core change is sound. When the runs of one operation fall in the same group, credits are now settled
once per `operation_id`: the latest status read wins, else the distinct charge runs add up. Legacy entries
without a receipt keep adding `usage.credits`. Synthesized legacy receipts carry their credits, and the
`receiptOf(e)` guard stops them being counted twice. The new fields are additive. `SpendSummary` and
`OperationSpend` are not re-exported from `src/index.ts`, and `worker/` does not import them, so no consumer
breaks. Per-run `usage` is unchanged.

The fix is only partial on the default `catalog usage` view (finding M1). The docs also claim more than the
code does.

## Critical issues

None.

## High priority

None.

## Medium priority

### M1. Grouping happens before settlement, so a task's credits still appear twice across rows. This includes the default `catalog usage --by offering`.

Locations:
- `src/catalog/usage-aggregate.ts:143-151`: groups by `keyOf`, then calls `settleOperations` per group.
- `src/commands/agent/history-command.ts:105-131`: same for the history stats buckets.

Deduplication only works inside one row. In a realistic path the submit and the status run land in
different rows:
- `catalog usage` defaults to `--by offering` (`src/commands/agent/catalog-command.ts:350`), which is
  `provider:model_resolved`.
- A status GET usually names no `model` / `modelVersion` (`MODEL_KEYS`, `src/agent/fetch-telemetry.ts:169`).
- So the status run goes to `<provider>:(unknown model)`, while the submit run goes to `<provider>:<model>`.

Probe P3 shows each row reporting the full 40 credits: 80 in total for one task. This is the double count
that #424 describes. `catalog offering` detail (`catalog-command.ts:273, 409`) also uses the offering
grouping. `history stats --by model|command` behaves the same way: the status run has no `e.model` (it lands
in `(none)`) or has a different `command`. Only the default `history stats --by provider` is fully fixed.

The new test hides this. The `usage-aggregate.test.ts` fixture gives the status entry the same
`model_resolved` as the submit (the `entry()` default). A real status run normally does not have it.

USD spend has the same pre-existing limitation, so this is not a regression. It does leave #424's expected
outcome ("one logical operation's charge counted once") unmet on the default `catalog usage` view.

Fix options:
- (a) Settle per operation across all entries first, then attribute each operation's credits (and USD) to
  the row of its earliest charge run, falling back to its first run.
- (b) Keep this PR as is, narrow the docs (see L1), and open a follow-up issue for cross-row attribution.

Also add a test where the status entry has `model_resolved: null` (or a different `command`).

## Low priority

### L1. The docs claim more than the code does

Locations:
- `docs-site/src/content/docs/reference/for-ai-agents.md:260-261` (and the VI copy) says "a submit and a later
  `status` of the same task count once". That holds only when both runs fall in one group (M1). Under
  `--by model` or `--by command` they do not.
- `docs-site/src/content/docs/commands/catalog.md:81-82` says "the total does not add them again". There is
  no grand total. Each row is settled separately, and under the default offering view the status run is often
  its own row.

Reword to "within a row" or "within a group", or fix M1.

### L2. `total_credits` includes observation-only operations that `operations[]` omits

Location: `src/budget/cost-receipt.ts:349-350`. Credits are added to `totalCredits` before the
`if (charges.length === 0 && !op.reported) continue;` line. An operation known only from a status read
(probe P2) contributes to `total_credits`, but no `OperationSpend` row carries its `credits`. So
`sum(operations[].credits) !== total_credits`.

This is intended (the comment says so), but the new `OperationSpend.credits` field gives the impression that
the list is complete. No current consumer sums `operations[].credits`.

Fix: either push a `status: "unknown"` / `actual_usd: null` row for such operations (check that the
`unknown` counter is not inflated by them), or document on `SpendSummary.total_credits` that it includes
operations that are not listed in `operations`.

### L3. A provider-reported status read replaces the sum of distinct charges, including a resubmit's credits

Location: `src/budget/cost-receipt.ts:344-348`.

Path:
1. An agent exports `MULTIX_OPERATION_ID=job-7`.
2. It submits task A, then resubmits as task B. Both are charge receipts with credits.
3. It runs `status A`, which reports A's credits.

`total_credits` then equals A's credits only (probe P1: 10 instead of 20). If both submits ran with
`--no-wait` and the last status read was of a refunded task (0 credits), the result is 0.

This matches the existing USD rule (`op.reported` settles the whole operation) and the earlier review's M2
(`plans/reports/code-reviewer-261026-0520-budget-guards.md`), so it is consistent rather than new. It does
contradict the test comment "a distinct resubmit adds up" when a status read is also present. The tests
cover the two cases separately but never together.

Recommendation: no change in this PR. If the operation-id semantics are revisited, key `reportedCredits`
per provider job id rather than per operation.

### L4. Credits on `refused` / `no_request` receipts are now dropped

Location: `src/budget/cost-receipt.ts:317` (`isNoSpend` → `continue`) together with the
`else if` in `history-command.ts:121` and the `receiptOf(e)` guard in `usage-aggregate.ts:174`.

Before this commit, `usage.credits` on such entries was summed. Now it is ignored (probe P4). In practice
this is close to unreachable:
- `recordUsage` only parses bodies when `response.ok`, so a 4xx refusal carries no credits.
- A `no_request` receipt has no responses at all.

Only a refused submit that also made a successful credit-reporting GET in the same run would lose credits.
I consider the new behaviour arguably correct. I note it only as a behaviour change.

## Edge cases checked and found correct

- Runway refund: a status read reports `cost.credits: 0`. `??` keeps 0 rather than falling through to the
  charges' sum.
- Runway `estimatedCost` on create is excluded by `ESTIMATE_PATH`, so a `--no-wait` submit carries no
  credits and the status read settles them.
- Legacy entry without a receipt: still adds `usage.credits`. Legacy entry with `usage.cost_usd`: the
  synthesized receipt carries credits under `run:<id>`, counted once. The guard prevents adding them twice.
- A receipt's `provider_reported.credits` is `round6(usage.credits)` from the same `summarizeUsage`
  (`agent-runtime.ts:284, 294`), so the two figures cannot diverge except by rounding. The
  `provider_reported` field has existed since receipts were introduced (#327).
- Verbatim replay of a charge receipt is deduplicated by the existing `at|status|actual_usd` key.
- `history stats` combines settled and legacy credits and rounds once. The key is omitted when both are
  absent, as before.

## Edge cases outside this diff (residual risk for #424)

Deduplication relies on the submit and status runs sharing `operation_id`.
- `operationIdFor` uses `run.ids[0]` (`src/budget/cost-receipt.ts:247`, `src/agent/cost-preflight.ts:169`).
- `jobIdentity` deliberately skips upload responses (`UPLOAD_PATH`, `src/agent/run-state.ts:143`), but
  `operationIdFor` does not.
- So a submit run that first uploads an input whose response carries an `id` gets
  `operation_id = <provider>:<uploadId>`. Its later `status <taskId>` gets `<provider>:<taskId>`, and the
  credits are still counted twice.

I did not confirm a provider on this branch where both conditions hold. Runway's upload ticket appears to
carry no `id`, and Leonardo's status body does not carry `apiCreditCost`. Worth a follow-up issue: use
`jobIdentity()` for the default operation id, as #424 itself suggests.

## Positive observations (risk calibration)

- The change is small and reuses the existing settlement rule, with no new abstraction.
- The tests run offline and exercise settlement and both aggregators.

## Recommended actions

1. (M1) Decide whether to fix cross-row attribution in this PR or narrow the docs and open a follow-up issue.
   Either way, add a test with the status entry in a different group (`model_resolved: null`).
2. (L1) Reword the EN and VI docs to "within a group / row" unless M1 is fixed.
3. (L2) Document that `total_credits` includes operations known only from a status read, or list them.
4. Open a follow-up issue for `operationIdFor` vs `jobIdentity` on upload-first submits (residual risk above).

## Metrics

- Type coverage: no `any` added; typecheck clean.
- Tests: 310/310 in the affected suites; 3 new tests.
- Lint issues: 0.

## Unresolved questions

- Which providers on `dev` repeat a task's credits in both the submit and the status body? The issue cites
  the providers from #413, which are not on this branch. Real exposure under M1 depends on whether their
  status responses name a `model`.

## Resolution (author)

- M1 fixed: `creditsByEntry` (`src/catalog/usage-aggregate.ts`) settles each operation's credits over the whole ledger, then puts them on the operation's first charge run (or, with none, its latest run that reported credits). Both `catalog usage` and `history stats` sum per-entry credits, so a status run grouped apart from its submit adds nothing. New tests use a status entry with `model_resolved: null` and group by offering and by command; they fail on 1a482ce and pass now. E2E against a local Runway mock: `catalog usage` (default `--by offering`) went from 80 credits to 40, and `history stats --by command` from 40 + 40 to 40 + none.
- L1 fixed: the English and Vietnamese docs now say credits show once, on the submit run's row.
- L2 documented on `SpendSummary.total_credits`.
- L3 kept: it is the same rule USD already uses, and a shared `MULTIX_OPERATION_ID` declares the runs to be one operation.
- L4 kept: refused and no_request runs carry no usage, because error bodies are not parsed for it.
- Residual risk filed as #439: the default operation id can name an upload id.
