# Code review: count a task's USD once across rows (#444)

Commit 4424751 on `claude/gracious-heisenberg-vydm37`. Isolated review. No source files were changed.

## Scope
- Source: `src/catalog/usage-aggregate.ts` (+85/-47) and `src/commands/agent/history-command.ts` (+17/-16).
- Tests: `tests/unit/catalog/usage-aggregate.test.ts` (+63) and `tests/unit/agent/history-store.test.ts` (+13).
- Docs, EN and VI: `docs-site/.../commands/catalog.md` and `reference/for-ai-agents.md`.
- Also read: `settleOperations` (`src/budget/cost-receipt.ts:309-389`), `costReceiptFor` (`src/agent/cost-preflight.ts:167`), the ledger writer (`src/agent/agent-runtime.ts:283-330`), and the callers (`src/commands/agent/catalog-command.ts:273,359,405`, `history-command.ts:206`) and `recommend.ts`.

### Callers
- `catalog show`, `catalog usage` and `catalog recommend` call `aggregateUsage`.
- `history stats` calls `historyStats`.
- `recommend` reads only `operations`, `completed` and `success_rate` (`src/catalog/recommend.ts:102-108`). It reads no cost fields, so this change does not affect it.
- Nothing in `worker/src` imports `usage-aggregate` or `history-command`.
- `src/index.ts` does not export `creditsByEntry`, so removing it breaks no public API.

## Verification
- `npm run lint`: clean. `npm run typecheck`: clean. `npx vitest run tests/unit`: 2500 passed, 22 skipped.
- New tests against the pre-fix source (HEAD~1 `src` extracted to the scratchpad, HEAD tests): 4 of the 5 new tests fail. They are real regression tests. The fifth ("keeps a task known only from a status read") also passed before; it guards behaviour that already worked.
- I ran probe scenarios on both the old and the new source with the same inputs. The results are cited below as P-A … P-H.

## Owner rule: edge cases checked

| Case | Result | Verdict |
|---|---|---|
| Operation with only `no_request`/`refused` receipts (P-A) | `settleOperations` skips it (`noSpendOnly`) and `total_credits` is null, so `continue` at `usage-aggregate.ts:123`. No owner and no crash. Same as before. | OK |
| Charges that are all noSpend, plus an observation that reports USD (P-B) | `charge` is undefined, so the fallback `reduce` picks the observation. The observation's row owns $2. Same totals as before. | OK |
| Same, but the observation has no figure (P-B2) | No spend and no credits, so `continue`. | OK |
| Uncertain submit settled by a status read | The submit owns a settled spend. Covered by a new test. | OK |
| Credits-only legacy entry (P-D) | Credits go on the earliest reporter (the submit). `unknown_operations` is 1, once (before the fix it was 1 in each row). | OK, fixed |
| Legacy USD on both submit and status (P-E) | Before: $3 in both rows. After: $3 once, on the submit row. | OK, fixed |
| Resubmit under one `MULTIX_OPERATION_ID` (P-C) | Regression, see M1. | Medium |

Can the fallback `reduce` (`usage-aggregate.ts:127-129`, no initial value) throw? A spend or credits figure exists only when one of these holds:
- a non-noSpend charge exists, which the `charge` predicate also finds; or
- a non-charge receipt is settled with a non-null USD, or reports credits, which `reported()` also matches.

So the filtered list is never empty and the reduce cannot throw today. This depends on two copies of the same predicate staying in sync (see L1).

## Findings

### High
None.

### Medium

**M1. A resubmit under one shared operation id moves the successful run's USD to the failed first attempt's row**

Evidence: `src/catalog/usage-aggregate.ts:124-126` takes the first charge run in ledger order as the owner. A failed submit is written with `model_resolved: null` (`agent-runtime.ts:283`; a failed run usually has no resolved model). The docs say a resubmit is a supported shape: "only each distinct paid submit (a resubmit is billed again) adds its cost" (`for-ai-agents.md:234-237`).

Probe P-C: a failed uncertain submit, then a successful resubmit at $1, both under one `MULTIX_OPERATION_ID`, grouped `--by offering`.

| Row | Before | After |
|---|---|---|
| `fal:m1` | known $1, per-success $1 | known $0, uncertain 0, per-success null, estimated $1 |
| `fal:(unknown model)` | uncertain 1, estimated $1 | uncertain 1, estimated $1 |

Impact:
- The model that actually ran and billed shows $0 known spend, with no unknown or uncertain flag that would explain it.
- The estimate is now counted in two rows (see M2).
- `catalog show <offering>` reads the same row (`catalog-command.ts:273,294`).

The operation is uncertain overall, so putting the uncertainty in one row is defensible. Putting it on the run with no model is the worst choice of owner.

Fix: prefer a charge run that names a model, then the first charge run:
```ts
const charges = runs.filter((r) => r.receipt.role === "charge" && !sentNothing(r.receipt));
const charge = charges.find((r) => r.entry.model_resolved) ?? charges[0];
```
Add a test with two charge runs under one id where the first failed without a model.

**M2. `estimated_usd` is still placed by receipt, not by owner, and its known-set ignores the provider**

Evidence: `usage-aggregate.ts:276` builds `knownIds` from `operation_id` alone. The estimates loop at `:307-314` adds an estimate to every row that holds a receipt carrying one. Spend, by contrast, is keyed `${provider}|${operation_id}` (`:109`).

There are two consequences.
1. **The estimate shows in a different row from the uncertainty.** In P-C, `estimated_usd: 1` appears in both rows, but the uncertain count appears in only one. Summed across rows, the estimates exceed the operations they describe. This contradicts the new docs: "an operation's spend … shows in one row".
2. **A known operation hides another provider's estimate (regression).** P-G: one `MULTIX_OPERATION_ID` is shared by fal (settled $1) and runway (unknown, expected $2). With `--by provider`, the runway row had `estimated_usd: 2` before the fix and has `null` after it. The existing test "keeps each provider's credits apart under one shared operation id" shows this case is treated as real. `accounted` (`:279`) has the same cross-provider leak for the unreceipted check.

Fix: key `knownIds` and `accounted` by `${owner.provider}|${operation_id}`; iterate `owned`'s entries to get the owner's provider. Then give each unknown or uncertain operation's estimate to its owner's row only, taking it from any run of the operation. This keeps the estimate in the same row as the `uncertain_operations` and `unknown_operations` it explains.

### Low

**L1. The noSpend predicate is duplicated, and the `reduce` safety depends on it**

`sentNothing` (`usage-aggregate.ts:114-115`) copies `isNoSpend` (`cost-receipt.ts:295-296`), which is not exported. `reported()` (`:116-118`) re-derives the conditions under which `settleOperations` keeps a settled figure or reported credits.

If `settleOperations` ever counts another source, the `reduce` on an empty array throws `TypeError` and `catalog usage` and `history stats` crash. Fix: export `isNoSpend`, and either give the `reduce` an initial value or fall back to `runs[0]`.

**L2. `history stats` `cost_usd` rounding changed**

`history-command.ts:133,143` now rounds the raw float sum to 4 places. Before, the sum was first rounded to 6 places (`total_usd` was `round6`).

A random test of 200k sums of round6 values found 224 that differ. Example: `0.04185 + 0.0545` gives `0.0963` now and gave `0.0964` before. The sum is exactly 0.09635 in decimal, so `0.0964` is the right answer. `aggregateUsage` still applies `round(…, 6)` first (`usage-aggregate.ts:300`), so the two commands can now disagree by 1e-4.

Fix: `Math.round(Math.round(usd * 1e6) / 1e6 * 1e4) / 1e4`.

**L3. Docs and comment accuracy**
- `catalog.md` says "Such a row shows no per-success cost for the operations whose cost lives elsewhere". The VI version says the same. But `per_success_usd` is one number per row, and the whole row gets `null` as soon as any operation it completed has its cost elsewhere (`usage-aggregate.ts:320-323`). Suggested wording: "Such a row shows no per-success cost when any operation it completed has its cost in another row."
- `catalog.md` says the owner is "the row of its submit run, or of its earliest run that reported a figure when a filter leaves the submit out". Two cases do not follow this:
  - Pre-receipt entries with a job are all observations (`receiptOf`, `:73`), so the earliest reporter owns them even when no filter is applied.
  - A cost-unknown operation with no receipt is counted on its first *successful* run (`:283`). When the legacy submit failed, that is the status run (P-H). Behaviour there is the same as before; the docs claim is what is inaccurate.
- `UsageRow.cost.per_success_usd` doc comment (`:257`): it does not state the new condition that the row must own the cost of every operation it completed.
- File header (`:22-24`): it says spend is "shown on the operation's submit run" without the fallback. The function doc at `:94-96` does state the fallback.

**L4. A status-only row reads as free**

P-B2 and the new test at `usage-aggregate.test.ts:581-591` show the effect. A row that holds only status runs (for example `fal:(unknown model)`) reports `completed: 1`, `known_usd: 0`, `unknown_operations: 0`, `uncertain_operations: 0`. Nothing in the row says that its cost was counted elsewhere. Text output prints `known $0`.

This follows directly from the design, and the docs mention it. A tiny `cost_elsewhere_operations` count would make the row self-explanatory. This is optional and out of scope for #444; it could be its own issue.

**L5. Gaps in test coverage**

The new tests cover the main #444 paths. These are not tested:
- The fallback owner when every charge is noSpend and an observation reports (the `reduce` branch with `charge` undefined).
- An operation whose receipts are all refused or `no_request`.
- `historyStats` moving `cost_uncertain_ops` and `cost_unknown_ops` across buckets. Only `cost_usd` is asserted.
- The global `estimated_usd`. The "uncertain submit settled by status read" test does not assert `estimated_usd` (before the fix the submit row showed the estimate; after it shows null).
- Resubmit ownership (M1).
- Two providers under one id for USD and estimates (M2).

Also, the new `historyStats` test (`history-store.test.ts:225-237`) uses legacy entries with equal `ts`. Both are observations, so the owner is chosen by ledger order breaking a tie in `reduce`, not by the charge rule. Add a variant with a receipted charge submit.

## Regressions in existing semantics

| Field | Result |
|---|---|
| `unknown_operations` | Correct; it now counts each unreceipted operation once (P-D, P-H). |
| `uncertain_operations` | Correct. |
| `per_success_usd` | Stricter, as intended. |
| `cost_unknown_ops` / `cost_uncertain_ops` in history stats | Moved to the owner's bucket. |
| `credits` | Unchanged. |
| `estimated_usd` | Regression in M2. |
| `cost_usd` rounding | Small drift, L2. |

## Filters
- `catalog usage --provider/--since` and `history stats --provider/--command/--since/--failed` filter before aggregation (`catalog-command.ts:354-359`, `history-command.ts:206`).
- When the submit is filtered out, the owner moves to the earliest run that reported a figure. This is documented, and the double count cannot come back in the filtered view.
- `--since` cannot keep a status read while dropping its later submit, because the submit always comes earlier.
- `operationOutcomes` is still decided over `sent` before grouping. The completed counts agree with the per-success rule: the op is "completed" in every row that holds one of its runs, and only the owner row can price it.

## Positive observations (risk calibration)
- The `[...arr, e]` patterns that were O(n²) were replaced with `push` at `:110-112,288-290`. `operationOutcomes` (`:195`) still uses the spread.
- The ledger-wide settle matches the credits design that was already reviewed in `code-reviewer-261029-1015-credits-once-per-operation.md`.

## Recommended actions
1. M1: choose a charge run with a resolved model as owner. Add a resubmit test.
2. M2: key `knownIds`/`accounted` by provider and operation. Put each estimate on the owner's row only. Add tests.
3. L2: round to 6 places before 4 in `historyStats`.
4. L1: export and reuse `isNoSpend`; make the `reduce` total.
5. L3: fix the docs wording on per-success (EN and VI), the legacy and unreceipted owner wording, and the `per_success_usd` comment.
6. L5: add the missing edge-case tests.

## Unresolved questions
- Should a row that owns none of its operations' cost say so (L4), or is the docs note enough?
- Is sharing `MULTIX_OPERATION_ID` across a failed submit and its resubmit an expected agent pattern? If yes, M1 should block the merge; if not, it can follow in a separate change.

Status: DONE_WITH_CONCERNS
Summary: The #444 fix is correct for the reported cases. The new tests are real regression tests, and lint, typecheck and the unit suite pass. Two Medium issues remain: a resubmit under one operation id moves the successful run's USD to the failed attempt's unknown-model row, and `estimated_usd` is still placed per receipt and keyed without the provider, so it is counted twice in one case and hidden in another.

## Resolution (author)
- M1: fixed. The owner is a successful charge that names the model, then a successful charge, then the first charge. The resubmit test asserts that the task's unknown cost stays on the model row. Before this change it moved to `(unknown model)`.
- M2: fixed. The pre-flight estimate is stored on the owner only, and only while the operation's cost is not known. `accounted` and the no-receipt owners are keyed by provider and operation. A test covers two providers that share one id.
- L1: fixed. `isNoSpend` is exported and reused, and the owner fallback is total (`earliest()` returns `undefined` on an empty list, which is guarded).
- L2: fixed. The value is rounded to 6 places, then to 4.
- L3: fixed. The docs (EN and VI) now cover per-success nulling, the successful-submit owner, operations without a receipt, and the estimate. The field comment is updated.
- L4: not changed in code. The docs note explains that the row shows no per-success cost.
- L5: tests added for resubmit, a shared id across providers with estimates, and a refused-only operation.
- Gates: lint, typecheck and build pass. The full suite passes (2821 passed, 22 skipped), and verify:docs passes.
