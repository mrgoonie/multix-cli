# Code review: #434 catalog usage counts outcomes per operation

Worktree: /tmp/claude-0/-workspace/eb7e4c35-d0fa-56dc-aa42-cccdb5b18f7a/scratchpad/wt-434 (uncommitted, base origin/dev 044dfec)
Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-29 UTC.

## Scope
- src/catalog/usage-aggregate.ts, src/catalog/recommend.ts, src/agent/history-store.ts
- tests/unit/catalog/usage-aggregate.test.ts, tests/unit/catalog/recommend.test.ts, tests/unit/agent/history-store.test.ts
- docs-site/src/content/docs/commands/catalog.md and vi/commands/catalog.md
- About 230 added and 50 removed lines.

## Verification run
- `npx vitest run tests/unit/catalog tests/unit/agent/history-store.test.ts`: 8 files, 209 tests passed.
- `npx tsc --noEmit -p .`: clean. `npx biome check` on the touched files: clean.
- Probe (a temporary test file, deleted afterwards) that calls `aggregateUsage` with ledger shapes the runtime actually writes. Results are cited below.
- Worker: `worker/src` imports only `src/catalog/catalog-query.ts`. It does not import usage-aggregate, recommend or history-store, so the worker is not affected. `check:mcp` is not needed.
- Other `readHistory` callers are history-command.ts (list/stats/show/rerun) and catalog-command.ts (verifiedUsage, usage, recommend). The new shape filter only removes lines that would already have broken them (no string id or ts). `multix history stats` math did not change.

## Overall
The logic matches the spec in the issue: outcomes are counted per `operationOf`, completed wins, the latest run decides otherwise, `requests` still counts runs, the recommend threshold now counts operations, `sentRequest` handles role "none", and `readHistory` skips lines with the wrong shape. Docs EN and VI match each other. One real gap remains. Outcomes are worked out separately inside each group row. The runtime often writes the runs of a single operation under different group keys, so the headline scenario ("a failed status poll of a job that then finished is not a failure") is still shown as a failure in a second row. Nothing is blocking. Ship-worthy after the Medium item is fixed or explicitly deferred.

## Critical
None.

## High
None.

## Medium

### M1. Outcomes are computed per group row, not per operation, so one operation can be "completed" in one row and "failed" in another
- Where: src/catalog/usage-aggregate.ts:174-180 (grouping) and :196 (`operationOutcomes(list)` runs on the group's list only).
- Scenario, reproduced with the probe. A fal submit run has `model_resolved: "m"`, command `fal video`, `ok: true`, operation `fal:J1`. A later status poll in the same operation has `ok: false` (NETWORK_ERROR), no `model_resolved` (agent-runtime.ts:282 sets it only from a successful JSON response body, fetch-telemetry.ts:290-300), and command `fal status`. Output:
  - `--by offering`: `fal:m` 1 op, 1 completed. `fal:(unknown model)` 1 op, 0 completed, **1 failed**, success_rate 0.
  - `--by command`: `fal video` completed. `fal status` **1 failed**.
  - `--by task`: `video` completed. `(unclassified)` **1 failed**.
  Status responses usually carry no model, and the poll command always differs from the submit command. So the case the docs promise to fix still shows as a failed operation under every `--by`, only in a different row. `recommend` (offering) is not hurt, because the phantom row maps to no offering. `catalog usage` output still reports the failure, and the operation is counted twice across rows.
- Fix (small): compute `operationOutcomes` once over all sent entries in `aggregateUsage`, before grouping. Then each row counts its operation ids against that global map. The better fix is to also key a run by its operation's resolved model or offering, inheriting it from any run in the operation that has one, so polls fall under the submit's offering. Add a test where the failed poll has no `model_resolved`. Today the test fixture `entry()` gives every run the same `model_resolved` and command, which hides this (tests/unit/catalog/usage-aggregate.test.ts:223-256).

### M2. In practice a failed poll usually has a different operation id from its job, so the documented guarantee holds only part of the time
- Where: src/catalog/usage-aggregate.ts:66-70 (`operationOf` prefers the receipt id) and src/budget/cost-receipt.ts:237-248 (`operationIdFor`). Docs: docs-site/src/content/docs/commands/catalog.md:78-80 and vi/commands/catalog.md:80-84.
- Scenario: provider ids are captured only from `response.ok` JSON bodies (fetch-telemetry.ts:290-306). `trackInFlight` is called only by atlascloud. A fal/replicate/etc. status run whose first request fails (network cut, 5xx, 4xx) therefore records no `provider_ids`, so its receipt gets `operation_id: run:<history id>` and it counts as its own failed operation. The new test sets `operation_id: "fal:J1"` on the failed poll by hand (usage-aggregate.test.ts:239-242), a shape the runtime only writes when the poll got at least one OK JSON response first.
- Fix: the operation-id format is out of scope (#424), so either (a) soften the docs to "a failed poll that is recorded under the job's operation…", or (b) record on #424 that per-operation outcomes depend on it, and link it from the PR. Also add a test with the realistic shape (failed poll, `run:` operation id) that pins the current behaviour, so the limitation is visible.

## Low

### L1. `operationOutcomes` mishandles a missing or non-string `ts`
- Where: src/catalog/usage-aggregate.ts:109 (`b.ts >= a.ts ? b : a`) and :213 (`times.sort()`).
- Probe: an operation [cancel with ts undefined, failure with valid ts] gives `canceled`. The valid later failure loses because `"2026…" >= undefined` is false. `last_at` comes out `""`. `readHistory` now filters these lines out, so this cannot happen through the CLI. `aggregateUsage` is exported and takes any array, though.
- Fix: none needed for the CLI. Optionally, treat a missing ts as oldest (`(b.ts ?? "") >= (a.ts ?? "")`).

### L2. Runs before receipts that sent work outside fetch are no longer counted
- Where: src/catalog/usage-aggregate.ts:86-91.
- Scenario: entries from before receipts were added (2026-10-21 to 10-26, before #327) for the codex image driver (external CLI, `run.externalRuns`, no fetch calls) were `ok` with no `http`, no `provider_ids` and no `cost`. They used to count and now drop out. This follows the spec in the issue and has a small window, but note it in the PR as an intended data change. Local `media` runs (receipt role "none") also stop counting as requests. That is correct, but the user can see the change.
- Fix: none required. Mention it in the PR body.

### L3. Without a receipt, `http.requests` counts blocked calls
- Where: src/catalog/usage-aggregate.ts:90. agent-runtime.ts:286-292 counts every `run.calls` entry, including `status: -1` calls that `buildCostReceipt` (cost-receipt.ts:154) treats as not sent. Affects only entries from before receipts. No fix needed.

### L4. `MIN_RUNS` now means operations
- Where: src/catalog/recommend.ts:16-17. The comment was updated but the exported name was not. Renaming would change an export. Optionally add `MIN_OPERATIONS` and keep `MIN_RUNS` as a deprecated alias in a later change.

### L5. Test gaps
- No test for equal `ts` ties (the code relies on ledger order: `>=` with reduce picks the later array element). Add two failed runs with the same ts, cancel second, and expect canceled.
- No test for an operation that mixes `ok` and `CANCELLED` (it should be completed). The behaviour is correct by inspection.
- No test for a failed run with receipt role "observation" or "charge" and no `http` (it should count as a request).
- The history-store test asserts filtering but not that a well-formed line *before* junk survives. That is minor.

## Edge cases checked
- An operation that mixes ok and canceled runs is completed. Correct.
- With ts ties, the later ledger line wins. Correct but untested (L5).
- Entries without ts: filtered by readHistory. Aggregator behaviour is in L1.
- Failed runs that sent requests: counted through receipt role charge/observation or through http/provider_ids. The old `e.job || e.cost` shortcut is gone. This correctly drops failed runs that have a role "none" receipt (missing key inside a provider group).
- `--since` filter: applied before aggregation, so an operation whose ok run is older than the cutoff but whose failed poll is inside the window counts as failed. This is inherent to windowing and acceptable, but worth a sentence in the docs if M1 is reworked.
- Spend: unchanged except that `allPriced` uses `completedOps.size`. This is the same truthiness as before (any ok run means a completed op).
- Rows are still sorted by `requests` (runs). That fits "requests stays run count".

## Docs
- EN and VI catalog.md match each other and describe the code accurately, except for the overclaim in M2 and the per-row split in M1.
- for-ai-agents.md (EN/VI), README.md and skill/SKILL.md do not mention the old "runs"-based reliability or success-rate definitions. Nothing stale.

## Recommended actions
1. M1: compute outcomes globally before grouping, or inherit the operation's offering for polls. Add a test where the failed poll has no `model_resolved` and a different command.
2. M2: qualify the docs sentence or link the limitation to #424. Add a test with the realistic `run:` operation id.
3. L5: add the tie and ok+cancel tests.
4. Mention the L2 data change in the PR body.

## Metrics
- Typecheck: pass. Lint (biome, touched files): 0 issues. Focused tests: 209/209 pass.

## Unresolved questions
- Should `--by offering|model` key a run by its operation's resolved model (inherited from the submit)? That would also fix the operation double counting across `(unknown model)` rows that predates this change. It may belong in #424 rather than here.
