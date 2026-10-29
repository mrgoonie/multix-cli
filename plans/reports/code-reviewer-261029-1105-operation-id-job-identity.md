# Code review: #439, the default operation id names the job

- Commit: `c0ef6db fix(agent): name the job in a receipt's default operation id` (HEAD on `claude/gracious-heisenberg-vydm37`)
- Files: `src/agent/cost-preflight.ts`, `tests/unit/agent/model-job-identity.test.ts`, `docs-site/src/content/docs/reference/for-ai-agents.md`, `docs-site/src/content/docs/vi/reference/for-ai-agents.md` (+20/-4)
- Reviewed: 2026-10-29 UTC, in a context separate from the author's

## Verdict

The fix is correct. I found no High or Medium issues. It changes the default id only when `jobIdentity()` exists and differs from `run.ids[0]`. That happens when `ids[0]` came from one of these:

- a failed call
- an upload
- a successful GET made before the first successful submit

In each of these cases, the new id is the job id that a status run reads back. So the change makes more runs share an operation and splits none. The one place that builds `operation_id` (`cost-preflight.ts:177-183`) now agrees with the fallback for older ledger entries (`src/catalog/usage-aggregate.ts:50-56`, which uses `e.job.id` first). The comment on that fallback (`usage-aggregate.ts:44-49`) was wrong before this change and is now right.

## Checks run

- `npx vitest run tests/unit/agent/model-job-identity.test.ts`: 13/13 pass.
- I ran the new test file against the source before the fix, in a temporary worktree that I have removed. 2 tests fail as they should:
  - `counts failed sends…` got `fal:rl-1`, expected `fal:req-ok`.
  - `names the prediction, not the input file…` got `replicate:file-abc`, expected `replicate:pred-xyz`.
  - So the tests do detect the bug.
- `npm run lint`: clean, 691 files. `npm run typecheck`: clean. `npm run build`: ok.
- `npm test`: 148 files passed, 8 skipped; 2807 tests passed, 22 skipped.
- `worker/` neither imports `operationIdFor` nor builds `operation_id`, so `check:mcp` is not needed.

## Answers to the questions

**1. Is the fix correct for every caller?**
Yes. `costReceiptFor` has one caller, `agent-runtime.ts:295`. `jobIdentity()` returns `undefined` when there is no group (`run-state.ts:160`), and `costReceiptFor` already returns early in that case (`cost-preflight.ts:175`). The filter on `run.ids` handles an `undefined` job. A duplicate id is harmless because only `[0]` is read (`cost-receipt.ts:251`).

The envelope's `job` is skipped for `notSent` runs and spend lookups (`agent-runtime.ts:284`), but the receipt calls `jobIdentity()` in all cases. This makes no difference in practice:
- A `notSent` run has no successful submit.
- For a spend lookup (`openrouter generation <id>`), the fallback to the first successful GET gives the looked-up generation id. That is the same id `ids[0]` gave before, and it still joins the lookup to the original generation's operation, as intended.

**2. Can the new id split operations that used to join?**
I found no case. I checked every status-style command:

| Command | File |
|---|---|
| atlas status | `src/providers/atlascloud/commands/status.ts` |
| sume status | `src/providers/sume/commands/status.ts` |
| replicate status | `src/providers/replicate/commands/status.ts` |
| runway status | `src/providers/runway/commands/status.ts` |
| topview status | `src/providers/topview/commands/status.ts` |
| leonardo status | `src/providers/leonardo/commands/status.ts` |
| byteplus status | `src/providers/byteplus/commands/status.ts` |
| heygen status | `src/providers/heygen/commands/status.ts` |
| fal status | `src/providers/fal/commands/status.ts` |
| fal result | `src/providers/fal/commands/result.ts` |

All of them issue only GETs, plus downloads that return no JSON. So `jobIdentity()` takes either the in-flight id or the first successful GET id that is not an upload (`run-state.ts:170`). Compared with the old `ids[0]`, the result differs only when `ids[0]` came from a failed poll or a request-id header, and then the new value is the job id. A submit run now records that same job id instead of an upload id or a rejected call's id, so the two runs now join where they used to split.

A status run whose successful response carries no job id at all keeps its old id (point L3 below). That limitation existed before and this change does not cause it.

**3. Does a resumed run produce the same id as its submit?**
Yes.
- `trackInFlight` puts the id at the front of `ids` (`run-state.ts:121-124`), and `jobIdentity` prefers `inFlight` (`run-state.ts:170`).
- Atlas: the submit (`prediction-runner.ts:267`) and the resume command, `atlas status <id> --wait` (`atlascloud/commands/status.ts:50`), both track the same prediction id. Both give `atlascloud:<id>`.
- Sume: the submit and `sume status --wait` both go through `completeJob`, which calls `trackInFlight` (`sume/commands/job-flow.ts:186-187`).
- `atlas --async` and `sume` without `--wait` track nothing in flight. They now use the first successful submit id instead of whatever came first. Before, that could be an id from a catalog GET, for example from `requestCatalog` in `job-flow.ts:250`. The new result matches what a later status GET returns.

**4. Are the tests sufficient, and are the docs accurate?**
The tests prove the two bug paths and that an explicit `MULTIX_OPERATION_ID` wins. The docs are accurate. Two coverage gaps and one doc nuance are listed under Low.

## High
None.

## Medium
None.

## Low

**L1. No test shows a submit run and its status run getting the same operation id. (`tests/unit/agent/model-job-identity.test.ts`)**
The tests check each run on its own. Two cases are not covered:
- A status run whose first poll fails with an `x-request-id` header and whose retry succeeds. This should now give `fal:<job>`; the old code gave the header id.
- A spend lookup's `operation_id`.

Possible fix: in the `does not count a failed status poll as a resubmit` case, add `{ "x-request-id": "poll-err" }` to the 503 response and assert `out.cost.operation_id === "fal:req-1"`. This is not blocking: `jobIdentity` already has tests, and the fix only puts its result first in the list.

**L2. The new doc sentence can be read too broadly. (`for-ai-agents.md:239-241`, VI `:238-240`)**
"(never an uploaded input file's id)" applies to `job`. The fallback, "else the first id a response returned", can still be an upload's id. That happens when a run uploads and then its submit is rejected; for example, the Replicate flow gives `replicate:file-abc`. Such a run usually cost nothing, so the effect is small.

Possible wording: "…where the job is the run's `job` (the submitted job, not an uploaded input file), else the first id any response returned…".

Separately, `reference/environment.md:42` (EN) and `vi/reference/environment.md:41` still give only `<provider>:<job id>` or `run:<history id>`. That is still true and needs no change. Linking to the for-ai-agents section would just keep the two pages consistent.

**L3. Two older limits still make the "job" pick the wrong id. This change does not cause either.**
- `fetch-telemetry.ts:304-305` stops recording ids after 10. A run that uploads 10 or more files that each return an id (for example Replicate `/v1/files`) never records the prediction id. Both `job` and the operation id then fall back to an upload id.
- `fal result` reads `GET /requests/{id}`, whose body may not contain `request_id`. That run then gets `run:<history>` or an unrelated id, and does not join its submit.

These come from how `jobIdentity` works and could be a separate issue if it matters. The command layer already knows the job id from its arguments; passing it in (as `trackInFlight` does) would fix both.

## Out of scope (as stated)
Ledger entries written before receipts existed store only `provider_ids`, so their job id cannot be recovered. A related, also inherent, effect: receipts written by older CLI versions keep their upload-based or rejected-call ids, so they stay split from newer status runs of the same job.

## Plan follow-ups
- #439 acceptance looks met. The issue can move from `in review` to `done` once the PR is opened with `Closes #439`.
- Optional: the L1 test and the L2 wording tweak.

Status: DONE
Summary: The fix is correct for its only caller. It never splits operations that used to join, and resumed runs keep the submit's id. The new tests fail on the old code and the whole suite, lint, typecheck and build pass. Only Low items remain: a cross-run test, a doc wording nuance, and older id-capture limits.

## Resolution (author)

- L1: the failed status poll test now returns an `x-request-id` header and asserts the receipt files under `fal:req-1`, the id its submit uses. It fails on the old code.
- L2: the docs (EN and VI) now say that the run's `job` never names an upload or a rejected call, and that the fallback is the first id any response returned.
- L3: filed as #477.
