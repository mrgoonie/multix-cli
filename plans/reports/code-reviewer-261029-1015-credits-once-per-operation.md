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

## Re-review (261029)

Date: 2026-10-29 (UTC). Scope: `git diff origin/dev...HEAD` (1a482ce, 045091f). Isolated reviewer; no source or test file modified.

### Verification

- `npx vitest run tests/unit`: 125 files passed, 8 skipped; 2195 tests passed, 22 skipped.
- `npx tsc --noEmit`: clean. `biome check` on the 6 changed TS files: clean.
- Offline probe (esbuild bundle of `src/` run from the session scratchpad, outside the repo), results quoted below.

### Assessment

The #424 path is fixed. A submit run and any number of `status` runs that share an `operation_id` count the credits once in every grouping of `catalog usage` and `history stats`, including when the status run lands in `(unknown model)` or in another command row. Each run's `usage` is only read, never mutated. The `Map<HistoryEntry, number>` identity is safe: both callers pass the same object references they then iterate (`entries.filter` keeps references), and `readHistory()` returns fresh objects per call. USD spend is unchanged: the new `credits` / `total_credits` fields are additive, and the `charges.length === 0 && !op.reported` skip still runs after credits are tallied, so `operations[]`, `total_usd`, `uncertain` and `unknown` are the same as before.

### Findings

**M1 (new regression). With a shared `MULTIX_OPERATION_ID`, credits move to another provider's row and can be lost.** `src/catalog/usage-aggregate.ts:83-88` and `src/budget/cost-receipt.ts:348-352`.
Ledger-wide settlement places all of an operation's credits on its first charge run. The latest status read replaces the sum of the charges. Before this branch, each run kept its credits in its own row. Path: an agent exports `MULTIX_OPERATION_ID=job-42` for a pipeline: `leonardo generate` (10 credits), `runway video --no-wait`, `runway status` (40 credits). Probe result for `catalog usage --by provider` and `history stats --by provider`: `[["runway",null],["leonardo",40]]`. On `origin/dev` it was leonardo 10, runway 40. Leonardo's 10 credits disappear, and Runway's 40 credits are shown as Leonardo credits. These are different units, so summing them across providers means nothing. The default id `<provider>:<job id>` cannot cross providers, so only the explicit env var triggers this. The skill describes that variable as grouping "submit/poll/download runs", but nothing stops a pipeline-wide value. Fix: key the credit settlement by `(provider, operation_id)`, or by job id where one is present, before attributing. Or at least settle within a provider, so units never mix and never move between providers. Add a test with two providers under one operation id.

**L1 (docs). "on its submit run's row" is not always true.** `docs-site/src/content/docs/reference/for-ai-agents.md:260-261`, `docs-site/src/content/docs/commands/catalog.md:81-84`, and the VI copies `vi/reference/for-ai-agents.md:259-260` and `vi/commands/catalog.md:84-87`.
Attribution runs over the entries left after the caller's filters (`filterEntries` in `history-command.ts:32-41`, `--provider` / `--since` in `catalog-command.ts:358-362`). When `--since`, `-c status` or `--failed` leaves out the submit, or when the operation has no charge run, the credits appear on the latest status run that reported them. The count is still once per view, so no credits are lost or doubled. Only the wording overstates. Suggested wording: "on its submit run's row, or on its latest status run when the submit is outside the filtered runs". The VI text mirrors the EN text accurately.

**L2 (pre-existing, now inconsistent with credits). USD can still be counted in two rows.** `src/catalog/usage-aggregate.ts:190-191` and `src/commands/agent/history-command.ts:133`.
Spend is still settled per row. A status read that reports `cost_usd` (a settled observation) counts again in its own row. Probe: submit `fal:m1` at $0.50, plus a status read with no model reporting $0.50 → `[["fal:(unknown model)",0.5],["fal:m1",0.5]]`. This is not a regression. But in the same table, credits are now attributed ledger-wide while USD is not, and `for-ai-agents.md:259` says `history stats` "counts each operation's cost and credits once". Open a follow-up issue to give USD the same attribution, rather than widening this PR.

**L3 (pre-existing, edge). Mixed ledger across the receipt upgrade.** `src/catalog/usage-aggregate.ts:71-74`.
Say a submit was written before receipts existed (no `cost`, `usage.credits` 40) and its `status` ran after the upgrade (receipt with credits 40). The submit keeps its own credits, and the status operation counts again. Probe: `[["runway",80]]`. This needs a receipt-less entry next to a receipted one for the same job, so it is very unlikely today. No action needed.

**Info (pre-existing performance, not introduced).** `src/catalog/usage-aggregate.ts:183`.
`groups.set(key, [...(groups.get(key) ?? []), e])` copies the array on every append, so a group costs O(n^2). Probe on 100k entries (`--by command`, 2 groups): `aggregateUsage` 47 s. The new `creditsByEntry` costs 263 ms for the same input, and 80 ms for one operation with 5,000 runs. Line 76 has the same copy pattern, but only per operation, so it is harmless. A 20 MB ledger (rotation limit) can hold tens of thousands of entries, so `catalog usage` and `catalog offering` can take seconds. Worth a separate issue (use `push`).

### Checked and correct

- `--failed`: a failed (uncertain) submit plus an ok status read. All runs give `[["runway video",40],["runway status",null]]`. With `--failed` the result is `[["runway video",null]]`, which matches `origin/dev` because the failed submit reported no credits.
- `--since` excluding the submit: the credits land once on the status row, never twice.
- Entries without a receipt keep `usage.credits` (legacy). Synthesized legacy receipts (`run:<id>`) are owned by the entry itself.
- The owner fallback `reduce` without an initial value cannot see an empty array: non-null `total_credits` implies a non-noSpend receipt with credits, and that receipt passes the filter.
- `aggregateUsage` attributes over `sent`. `historyStats` attributes over `counted`. Every receipted, non-dry entry is in both, so no owner is dropped from a row it should be in.
- Tests are offline and assert real behaviour (two of them fail on 1a482ce, per the author's note). Gaps: no `history stats --by model` case where the status run has no `model`, no filtered-input case, and no multi-provider operation id case (M1).

### Recommended actions

1. M1: settle credits per provider (or per job) within an operation id, and add a cross-provider test.
2. L1: adjust the EN and VI wording for filtered views.
3. Open follow-up issues for L2 (cross-row USD) and the O(n^2) grouping.

## Re-review resolution (author)

- M1 fixed: `creditsByEntry` keys operations by provider and operation id, so a shared `MULTIX_OPERATION_ID` never mixes providers' credits. New test: leonardo 10 + runway 40 under one id. It fails without the key and passes with it.
- L1 fixed: the docs say credits show "normally" on the submit row, or on the latest status run when a filter leaves the submit out.
- L2 (USD across rows, predates this change) filed as #444.
- L3 (a submit written before receipts, with a status run after) kept: the mixed ledger only exists across the upgrade boundary.
- Info (quadratic grouping) filed as #445.

## Review of d5f3ea2 (261029)

Scope: `src/catalog/usage-aggregate.ts` (+58/-14), tests in `tests/unit/catalog/usage-aggregate.test.ts` and `tests/unit/agent/history-store.test.ts`. I also read `settleOperations` and `operationIdFor` (`src/budget/cost-receipt.ts`), `historyStats` (`src/commands/agent/history-command.ts`), the ledger writer (`src/agent/agent-runtime.ts:271-372`) and `jobIdentity` (`src/agent/run-state.ts:152`).

Verification: `npx vitest run tests/unit` gave 125 files and 2200 tests passed (22 skipped). `npx tsc --noEmit` exited 0. I also ran a probe with esbuild and node against `src/` (scratchpad only, no tracked files touched).

### Verdict

Do not land as a fix for #424. The code is type-safe and green, but the new path only runs for a ledger shape the writer never produces. Real ledgers written before receipts still double-count. The tests pass only because they use synthetic fixtures.

### H1. The legacy job path is dead code: real pre-receipt entries have no `job`

`src/catalog/usage-aggregate.ts:43-45, 59-60, 111`

- `cost` was added to `HistoryEntry` in 1a1e1b3 (#327, 2026-10-26). `job` was added a day later in 1bad7f4 (#394, 2026-10-27). (`git log -S` on `src/agent/history-store.ts`.)
- The only writer is `appendHistory` at `src/agent/agent-runtime.ts:310`. It gates both fields on `run.group`. `jobIdentity()` returns undefined when `!state.group` (`run-state.ts:153`). `costReceiptFor()` returns undefined when `!run.group` (`cost-preflight.ts:164`). So `job` present implies `cost` present.
- So an entry with `job` but no `cost` never exists on disk. Entries written before receipts carry `provider_ids` (since bfd7e60, #282) and no `job`. `legacyOperationId` still gives them `run:<id>`.
- Probe: two pre-receipt `fal` entries (submit and status), both with `provider_ids: ["req_1"]` and `usage: {cost_usd: 3, credits: 12}`:
  - `operationOf` gives `run:h_a` and `run:h_b`.
  - `aggregateUsage(…, "provider")` gives `known_usd: 6`, `operations: 2`, `credits: 24`.
  - `historyStats` gives `cost_usd: 6`, `credits: 24`.
  - This is the exact $3 + $3 the commit message says it fixes.
- The "joins an old entry … to a newer receipt" case and the `accounted` filter (`:231-237`) are dead for the same reason. A real unreceipted entry has `run:<own id>`, and no receipt from another run can carry that id unless `MULTIX_OPERATION_ID` is set to that exact string.
- Fix: derive the legacy operation the way `operationIdFor` does: `e.provider_ids?.[0] && e.provider ? \`${e.provider}:${e.provider_ids[0]}\` : \`run:${e.id}\``. `provider_ids` is written from the same `run.ids` that `operationIdFor` reads (`agent-runtime.ts:343`, `cost-preflight.ts:169`), so it matches newer receipts byte for byte. Keep `e.job` first if you want, but `provider_ids` is the field that exists. Rewrite the fixtures to use `provider_ids` without `job`, so the tests describe the real shape.
- Caveat for that fix: a pre-receipt submit whose `provider_ids[0]` is an upload id will not join its status run. `operationIdFor` has the same weakness, so the result stays consistent with receipts. Document it rather than guess.

### M1. Legacy credits move off the submit row to the latest run (where the path is reachable)

`src/catalog/usage-aggregate.ts:96-101, 107-113`

- Every legacy run with a job is now `role: "observation"`, so `creditsByEntry` finds no charge. It falls back to the latest run that reported credits. That is usually the status run, which has no `model_resolved` and a different command.
- Probe with `by: "model"` (submit `model_resolved: "flux"`, status run without one, 12 credits each): before the commit the rows were `flux 12`, `(unknown model) 12`. After it, they are `(unknown model) 12`, `flux undefined`.
- This contradicts the docstring at `:73-76` ("placed on its first charge run (the submit, which names the model)") and the intent of 045091f.
- It is latent today because of H1. If H1 is fixed with `provider_ids`, it becomes reachable and real.
- Fix: for legacy owners, prefer the earliest run, or the run with `model_resolved`, over the latest run.

### M2. USD across rows stays doubled for legacy jobs with `by` model or command

`src/catalog/usage-aggregate.ts:215-216`

- `aggregateUsage` settles receipts per row. A legacy submit (model row) and its status run (unknown-model row) each settle $3 as an observation.
- This predates the commit and is already filed as #444. The commit message and test names still claim "counts a job's cost once", which holds only when both runs share a row.
- Narrow the claim in the test names, or link #444 in the commit message.

### L1. Legacy runs with a job are always "observation", so a real second charge under one id would be swallowed

`src/catalog/usage-aggregate.ts:60`

- With observation semantics, the latest figure replaces the sum (`cost-receipt.ts:338-341`). Two pre-receipt runs that each billed under the same provider id would undercount. Example: a resubmit that reused an id, or a provider whose GET re-bills.
- I found no provider that does this. Accepted risk; note it in the docstring.

### Checked and found correct, or not affected

- Job provider vs entry provider: both come from `run.group` (`run-state.ts:180`, `agent-runtime.ts:317`), so `${entry.provider}|${op}` in `creditsByEntry` cannot split. No divergence path exists.
- Legacy entries whose job has failed attempts: `attempt` counts failed sends inside one run, not separate entries. `retries` is unchanged. Failed (`ok: false`) unreceipted runs are excluded from `unreceipted` as before.
- `estimated_usd`: legacy receipts carry no `estimate`. When the operation ids join, a known legacy figure now suppresses a newer receipt's estimate, which is correct. Unreachable today (H1).
- `per_success_usd` and `allPriced`: unchanged for real ledgers (H1). For the synthetic shape, operations dedupe, so per-success is $3 rather than $3 over 2 operations.
- Consumers: `receiptOf` is used by `historyStats` (`history-command.ts:120`) and re-exported at `:22`. `operationOf` is used only inside `usage-aggregate.ts` and its test. Nothing in `worker/` imports either. Dropping the `job:` prefix from `operationOf` changes no persisted data.
- `legacyCreditsReceipt` (`status: "unknown"`, observation): `settleOperations` counts its credits and skips it from `operations` (no charge, no reported figure), so the USD unknown counts do not move.

Status: DONE_WITH_CONCERNS
Summary: Tests and typecheck pass, but the new legacy-job path never runs on real ledgers: `job` was added after receipts, so entries without receipts have no `job`. The $3 + $3 double count from #424 still reproduces with real pre-receipt entries.

## Resolution of the d5f3ea2 review (author)

- H1 (legacy path never runs): `legacyOperationId` now builds the id with `operationIdFor` from `job.id`, else from `provider_ids[0]`, else from the run id. Pre-receipt entries carry `provider_ids`, so a submit and its status run share `<provider>:<id>`. A legacy entry that joins a job reads as a status read (role observation). Only an entry with no provider id stays a charge of its own run. The tests now use the real ledger shape (`provider_ids`, no `job`): $3 + $3 settles to $3, and 12 + 12 credits to 12.
- M1 (latest owner): the legacy credits owner is now the earliest run that reported credits. This is the submit, which names the model. Covered by "puts an old job's credits once, on its first run's row".
- M2 (USD across rows): still tracked in #444. The PR body links it.
- L1 (second charge under one id is swallowed): accepted. The `receiptOf` docstring states it.
- Gates: lint, typecheck, build, full test suite (2518 passed), verify:docs and check:mcp are clean.

## Review of 335f133 + merge (261029)

Scope: `git show 335f133` (src/catalog/usage-aggregate.ts, both test files, docs) and `git diff 335f133 HEAD -- src/catalog/usage-aggregate.ts` (dev's #448 `operationOutcomes`, `sentRequest`, per-operation outcome counts).

Verification:
- `vitest run` on usage-aggregate, history-store and cost-receipt tests: 69 passed. `tsc --noEmit` is clean. Biome on the touched files is clean.
- Ledger shape checked against history: `cost` was added in 1a1e1b3 (#327, 10-26) and `job` in 1bad7f4 (#394, 10-27). So pre-receipt entries have `provider_ids` and no `job`, as the commit says. At 1a1e1b3^, `run.ids` is filled in call order (`fetch-telemetry.ts:194` at that revision). It holds body ids first and then `x-request-id`/`request-id`/`x-amzn-requestid` header ids, there is no `trackInFlight` unshift, and non-ok bodies are not parsed.
- Live receipts build their id the same way (`cost-preflight.ts:177-181`, `operationIdFor` over `run.ids`). So the legacy path now matches what receipts do, and a pre-receipt submit joins a post-receipt status run of the same job.
- Scratch probes (vitest, outside the repo) on real legacy shapes:
  - P1: an ok submit plus a JOB_FAILED status run, both with `provider_ids: ["J"]`, gives operations 1, completed 1, failed 0.
  - P3: a submit with no credits, then status runs reporting 5 and then 8 credits. The owner is the first status run, with amount 8.
  - P4: `historyStats` by model, with cost 3 / credits 4 on both runs. Credits appear once. `cost_usd` 3 appears in both buckets (#444).
  - P6: two legacy runs share a first id at $1 and $2. Result: 1 operation, known $2.

### 1. Fix correctness on real ledger shapes

This is correct for the common shape. A submit whose first response body names the job, and a `status` run whose first GET body names the same id, now share `<provider>:<id>` (`usage-aggregate.ts:50-56`). They settle as observations (`:73`), so $3 + $3 settles to $3 and 12 + 12 credits to 12. The `e.job` branch is dead on real ledgers, because every entry with `job` also has `cost`. It is harmless, and the synthetic test at `usage-aggregate.test.ts:173-182` covers it.

### High

None.

### Medium

**M1. A job that failed at the provider is counted as completed once its legacy status run joins the submit (merge interaction with #448).**
- `operationOutcomes` (`usage-aggregate.ts:172-188`) groups runs by `operationOf`, which falls back to `legacyOperationId` (`:143`). It marks the operation completed when any run is `ok` (`:180`).
- Before 335f133, a legacy status run without a job had the id `run:<id>`, so a JOB_FAILED status read was counted as a failed operation of its own.
- After 335f133 the status run's `provider_ids[0]` is the job id. That is the normal case, because the failed-status GET returns 200 with a body naming the request. The run joins the submit, the submit was `ok` (the job was accepted), and the operation reads as completed.
- Probe P1 shows the result: failed 0, success_rate 1 for a job the provider reported as failed.
- So yes, a legacy failed status run now flips an outcome: it removes a real failure.
- The same masking already applies to receipted entries under #448, because their receipt joins by `run.ids[0]` too. 335f133 extends it to the whole pre-receipt ledger. The #448 rule "a failed poll recorded under the job's operation is not a failure" (`:15-18`) is right for transport failures (NETWORK_ERROR, timeout). It is wrong for a terminal provider verdict.
- Fix: open a separate issue rather than widening this PR. In `operationOutcomes`, let a terminal job verdict decide, for example:
  ```ts
  const terminal = ops.filter((e) => e.error?.code === "JOB_FAILED");
  if (terminal.length && !ops.some((e) => e.ok && e.ts > latestTs(terminal))) outcomes.set(id, "failed");
  ```
  Alternatively, do not count a submit-only `ok` (a run that returned a job id without outputs) as completion when a later run reports JOB_FAILED. Add a test with an ok submit plus a JOB_FAILED status run.

### Low

**L1. Legacy `provider_ids[0]` is not always the job id, so some pre-receipt jobs still double count.**
- At 1a1e1b3^, ids are appended in call order with no in-flight unshift. If the submit was preceded by any response that carries an id, `provider_ids[0]` is that id and not the job, and the status run (`fal:<job>`) does not join. Examples are a failed POST retry with an `x-request-id` header, or an upload that returns `id`.
- Same root cause as #439 (the op id ignores job identity), applied to legacy data. Note it on #439 instead of fixing it here.

**L2. The credits owner is not always the submit.**
- When the submit reported no credits, the owner is the earliest status run that did (`usage-aggregate.ts:111-113`, probe P3). Its row usually has no resolved model.
- The amount is the latest run's figure (`settleOperations` `reportedCredits`, `cost-receipt.ts:333-335`), which is correct.
- The code comment and docs say "earliest run that reported credits", which is accurate. The author's resolution note ("This is the submit, which names the model") holds only when the submit reported credits. No code change is needed. Do not repeat that claim in the PR body.

**L3. Test gaps for the new join.**
- `tests/unit/catalog/usage-aggregate.test.ts` has no legacy-shape outcome test: an ok legacy submit plus a failed legacy status run with the same `provider_ids[0]`. That case now gives 1 completed operation where it gave 1 completed + 1 failed before, and nothing pins it.
- There is no JOB_FAILED case (M1).
- There is no case for the `run:` prefix role switch on a legacy entry that has `provider_ids` but failed before any body id, where only a header id is present.
- The credits test at `:218-241` covers only the owner when the submit reported credits.
- `tests/unit/agent/history-store.test.ts:164-176` covers the bucket case. Its `provider` grouping hides the cross-bucket USD duplication (#444), which is fine since that is out of scope.

Accepted earlier, not re-raised: two legacy runs billed under one shared first id count only the latest figure (P6). This is stated in the `receiptOf` docstring (`:63-64`).

### 3. `historyStats` (src/commands/agent/history-command.ts)

No regression found.
- Within a bucket, legacy receipts now join and settle once (`:120-121`, `:133`).
- Credits come from `creditsByEntry` over the filtered set (`:105`, `:122-123`) and appear once (P4).
- `success_rate` is still per run (`:138`) and does not use `operationOutcomes`, so M1 does not reach `history stats`.
- Remaining differences are already known: USD repeated across model/command buckets (#444), and credits moving to a status run when `--since`/`--command` filters exclude the submit (documented).

### Checklist

- Concurrency: n/a (pure functions over a ledger snapshot).
- Error boundaries: no new throws.
- API contracts: the shapes of `receiptOf`/`operationOf` are unchanged. Values change for legacy entries, and nothing is persisted.
- Backwards compatibility: the ledger is read-only here.
- Trust boundaries: no new input or output surface. `operation_id` still truncates at 200.
- Query efficiency: still O(n) with array-spread appends per key, unchanged.

Status: DONE_WITH_CONCERNS
Summary: 335f133 now joins real pre-receipt submits and status runs, so USD and credits are counted once. Tests, typecheck and lint pass. Combined with #448's outcome rule, a legacy JOB_FAILED status run now joins its ok submit and the failed job counts as completed (M1). This needs its own issue.

## Resolution of the 335f133 + merge review (author)

- M1 (JOB_FAILED status joined to an ok submit counts as completed): the rule that decides it is #448's (any ok run means completed), and it already held for receipted entries. Filed as #471, to be fixed in its own PR.
- L1 (`provider_ids[0]` is not always the job id): same cause as #439; noted there.
- L2: the PR body says the owner is "the submit, or the earliest run that reported credits", which matches the code. Corrected here: the owner is the submit only when the submit reported credits.
- L3: the JOB_FAILED test goes with #471; the other cases are covered by the rules in place and are left out.
