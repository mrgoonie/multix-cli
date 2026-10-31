# Code review: classify provider-ended jobs as JOB_FAILED (#471, #473)

Range: `origin/dev..HEAD` on `claude/relaxed-clarke-m00f02` (c765c7e, 159b87f; 71c556d only adds the
earlier review report). 17 files, +241/-46.

## Verification run
- `npx biome check src tests`: clean. `npx tsc --noEmit -p .`: clean.
- `npm run build` then the full `npx vitest run`: 148 files / 2804 tests pass (8 files skipped).
- `npm run check:mcp`: worker typecheck, 537 worker tests and the bundle check pass ("1 file(s) clean").
- Probe: a temporary vitest file (since deleted; the working tree is unchanged) classified real error objects
  with `classifyError` and, for comparison, the same message wrapped in a plain `ProviderError` (old behavior):

| Case | New code | Old code |
|---|---|---|
| MiniMax logged line `Task 123 failed: {"status":"Failed",...}` (`classifyMessage`, the path production uses) | UNKNOWN | UNKNOWN |
| `ReplicatePredictionError` status `canceled` | JOB_FAILED | UNKNOWN |
| HeyGen Video Agent `waiting_for_input` (via `assertJobSucceeded`) | JOB_FAILED | UNKNOWN |
| `TopviewTaskError` on a `success` task, "no replaced image has a face ... use --mode avatar2" | JOB_FAILED | UNKNOWN |
| `ReplicatePredictionError` reason "insufficient credit balance" | JOB_FAILED | QUOTA_EXCEEDED |
| `ReplicatePredictionError` reason "Prediction timed out" | JOB_FAILED | TIMEOUT |
| `HttpError(403, "Sorry, you have been blocked")` on a status URL | CONTENT_BLOCKED | CONTENT_BLOCKED |

## Overall
The approach is sound: one marker class, checked before the text fallback, with a `terminal`
escape hatch. Throw sites for Replicate, Atlas, Runway, Sume and Gemini are real provider-terminal
verdicts. Poll timeouts stay `PollTimeoutError`, and "not finished" / malformed responses stay plain
`ProviderError`. Two claims in the change are not true in production: the MiniMax change has no
effect, and the sticky "any JOB_FAILED run fails the operation" rule now also catches
user-initiated cancels and a resumable HeyGen pause. The tests check constructors, not the
code paths that produce these errors.

## High

### H1. The MiniMax change does not take effect: the error class is discarded before classification
`src/providers/minimax/client.ts:108` now throws `ProviderJobFailedError`. Its only caller,
`src/providers/minimax/generators/video.ts:75-82`, catches every error and turns it into
`{ status: "error", error: e.message }`. `commands/generate-video.ts:73-75` then calls
`logger.error(...)` and `process.exit(1)`. `finalizeRun` therefore has no error object, and
`classifyMessage(lastErrorLine)` classifies the text. The text `Task <id> failed: {...}` does not
match the JOB_FAILED rule (the id sits between the noun and the verb, and the JSON has
`"status":"Failed"`, not `status: failed`). Probe result: **UNKNOWN**, as before. So #471/#473 are
not fixed for MiniMax video. The unit test (`error-classify.test.ts`,
`new ProviderJobFailedError("Task 77 failed: {}", "minimax")`) builds the class directly and
never runs the real path. It is a phantom test.
Fix: in `generateMinimaxVideo`, let a `ProviderJobFailedError` from `pollAsyncTask` propagate
(rethrow it), or make the generator result carry the error object and have the command throw it
instead of `process.exit(1)`. Add a test that drives `generateMinimaxVideo` with a mocked fetch
returning `status: "Failed"` and asserts the classified code. Separately, the MiniMax poll timeout
at `client.ts:115` is a plain `ProviderError("... timed out ...")`. Text classification turns it into
TIMEOUT, which is acceptable, but it is not a `PollTimeoutError`.

## Medium

### M1. A cancel the user requested now counts as a provider job failure (exit 5, usage "failed", sticky)
`multix replicate cancel` (`replicate/commands/cancel.ts`) and `multix sume cancel`
(`sume/commands/cancel.ts`, which refunds the job) are user actions. A later `status` run, or a
concurrent `--wait` run, then throws `ReplicatePredictionError(canceled)` /
`SumeJobError(..., "canceled")`. These are now JOB_FAILED: exit 5, hint "adjust inputs and retry".
`isJobFailure` (`usage-aggregate.ts:100-101`) runs first, so the operation is **failed** even
though the cancel run itself exited ok. The test suite locks this in
(`new SumeJobError("j1", "canceled")` is expected to be JOB_FAILED). The docs only say "A job the provider
itself canceled counts as failed", so a user cancel through multix is undocumented and arguably
wrong: it lowers the provider's success rate for something the user did.
Options: (a) construct these errors with `terminal: status !== "canceled"` for Replicate/Sume (and Runway
`CANCELLED`, Gemini `cancelled`), so a cancel falls back to text classification and leaves usage
stats alone; or (b) keep JOB_FAILED but state in the EN/VI catalog docs that a canceled job (including one
canceled with `multix <provider> cancel`) counts as failed. Product decision; (a) matches the
"provider's own verdict" wording.

### M2. A HeyGen Video Agent paused for input (`waiting_for_input`) is marked a terminal failure, inconsistent with the TopviewPrediction exclusion
`heygen/jobs.ts:171-202` maps `waiting_for_input` to `done: true, succeeded: false`, with the text
"continue the session in the HeyGen app". `assertJobSucceeded` (`jobs.ts:320`) throws
`HeygenJobFailedError`, and `terminal` defaults to `true`. Result: JOB_FAILED (probe). The usage
operation is permanently **failed**, even if the user continues the session and a later
`heygen status` exits ok, because JOB_FAILED is sticky. This is the same "resumable, not a verdict"
case that was the reason for leaving `TopviewPredictionError` out.
Fix: in `assertJobSucceeded`, pass `terminal: state.failureCode !== "waiting_for_input"` (or
`state.status !== "waiting_for_input"`), and add a test.

### M3. Leaving TopviewPredictionError out is the wrong trade-off: `terminal` already handles payment_required
TopView platform `prediction` / `completePrediction` (`topview/commands/prediction.ts:77`,
`task-flow.ts:365`) are the main TopView v2 path. A `failed` prediction is a provider-terminal
verdict. Its message `TopView prediction <id> failed: ...` still classifies as UNKNOWN (same
id-between-words gap), so #471/#473 stay open for it. The new class already supports the
exception. Make `TopviewPredictionError extends ProviderJobFailedError` with
`terminal: prediction.status !== "payment_required"`. `payment_required` then falls through to the text
rules, and its message contains "payment required", which maps to QUOTA_EXCEEDED (exit 5, `models --ready`
next step). It is not a job failure in usage and stays resumable. Add one test per status.

### M4. TopviewTaskError also covers "succeeded but output unusable", which is not a provider verdict
`TopviewTaskError`'s doc says "or finished without the output the next step needs". The throws at
`topview/commands/product-avatar.ts:216` and `:281` fire on a `success` task. The "no replaced
image has a face ... use --mode avatar2 ... --replace-image-id" case is a local mode constraint,
and the fix is to resume with different flags. That is not a provider failure, and the paid replace
stage succeeded. These are now JOB_FAILED (probe), so (a) the hint "adjust inputs and retry" and
exit 5 push an agent to resubmit a paid stage, and (b) the operation is counted failed for good.
Fix: pass `terminal: false` from those two throws (an optional `terminal` argument to
`TopviewTaskError`), or use a plain `ProviderError` there. The `final.status !== "success"` throws
(`task-flow.ts:249`, `status.ts:87`) and the m2v export `fail` (`m2v.ts:250`) are correct as they are.

### M5. Sticky JOB_FAILED regresses explicit `MULTIX_OPERATION_ID` retries
`operationIdFor` (`budget/cost-receipt.ts:247-248`) lets an agent group runs under one explicit
operation id. A first submit whose job fails (JOB_FAILED), followed by a resubmit under the same id
that succeeds, is now **failed**. Before, it was completed. This review asked for "sticky" behavior,
but only for runs of the same provider job. Fix: make JOB_FAILED sticky per provider job id. An ok run
with a different `provider_ids[0]` / `job.id` (a real resubmission) still decides completed. Add a test.
At minimum, document it.

## Low

### L1. Text-based CONTENT_BLOCKED on a status poll can fail a completed job
`isJobFailure` treats any `CONTENT_BLOCKED` run as the provider's verdict. A status poll that gets a
WAF/CDN 403 page ("Sorry, you have been blocked") classifies as CONTENT_BLOCKED (probe;
`codeFromHttp` 403 + the `blocked` rule). That transient poll failure now overrides an ok run.
Option: count CONTENT_BLOCKED as a job failure only when the run has no `http_status`, or only
when it came from a `ProviderJobFailedError` (for example, record a flag in the ledger).

### L2. A provider reason naming quota now loses its QUOTA_EXCEEDED next step
A `ProviderJobFailedError` whose reason says "insufficient credit balance" was QUOTA_EXCEEDED and is now
JOB_FAILED (probe). Exit code 5 is unchanged, but `nextForError` (`result-envelope.ts:133`) no
longer suggests `multix models --task ... --ready`. Consider keeping QUOTA_EXCEEDED, the same way
CONTENT_BLOCKED is kept. The TIMEOUT→JOB_FAILED change for a provider-side timeout is an improvement
(the job is terminal, so "resume, don't resubmit" was wrong).

### L3. HeyGen batch: the whole run is JOB_FAILED when only some jobs failed
In `completeJobs` (`node-helpers.ts:513-549`), if every failure is a provider verdict, `terminal` is
true even when other jobs in the batch were delivered. The run's operation is
`heygen:<first id>` (`cost-receipt.ts:250`). If job 1 delivered and job 2 failed, operation
`heygen:<id1>` is counted as a sticky failure. The `terminal` logic is otherwise correct: a poll rejection
(including `PollTimeoutError`) or a download failure makes it `false`, and the mixed text then
classifies by its content (TIMEOUT for a poll timeout, which is the right resume signal).
This is a pre-existing multi-job ledger limitation, made sticky by this change. Note it in the docs or track it.

## Test adequacy
- Phantom: the MiniMax and Gemini omni cases construct `ProviderJobFailedError` directly. No test drives
  `pollAsyncTask`/`generateMinimaxVideo`, `runOmniVideo`'s terminal/non-terminal branch, or
  `video-status`.
- `completeJobs`' `providerFailures` counting is untested. The only test passes `terminal=false` to the
  constructor by hand. Add batch tests: provider-only failure gives JOB_FAILED; provider plus download failure,
  or provider plus poll timeout, gives not JOB_FAILED.
- The usage tests use hand-written `error.code` rows. That is acceptable for the aggregator, but none
  covers the cancel, explicit-operation-id or WAF cases above.

## Checked, no issue
- Throw sites: Replicate `assertSucceeded` / `status.ts:60` (failed/canceled/aborted only);
  Atlas `isFailureStatus`; Runway `isTerminalStatus` (FAILED/CANCELLED; "SUCCEEDED without output"
  stays a plain malformed `ProviderError`); Sume `failJob` / `status.ts:60` (terminal and not
  completed; `getJob` failure is swallowed and the status still decides); Gemini `video-status.ts:77`
  and `omni-flow.ts:443` (terminal set completed/failed/cancelled/incomplete; non-terminal stays
  `ProviderError`, and poll timeout rethrows `PollTimeoutError`). None of them is a download failure or a local error.
- Old-code dependents: `agent-runtime.ts:260` maps UNKNOWN to the command's own exit (1). These errors
  now get exit 5, but only in `--json` mode; plain runs keep exit 1. `nextForError` has no
  UNKNOWN/JOB_FAILED branch (both `[]`). No retry policy branches on these classes:
  `isTransientHttpError` only accepts `HttpError`. Existing `instanceof ProviderError` checks still
  hold (the class extends `ProviderError`). The `code` stays `PROVIDER_ERROR`.
- Worker/MCP: `worker/src/mcp-server.ts` uses `classifyMessage(message)` only, so the class-based
  mapping does not reach MCP tool errors (unchanged behavior). The container runs the CLI without
  `--json`, so job `exit_code` stays 1 unless the caller passes `--json`. `check:mcp` and the bundle check
  pass. `errors.ts` stays runtime-neutral.
- Regex narrowing: no source message uses "request failed" for a job ("Cloudflare request failed with
  HTTP ..." takes the HTTP branch; "HeyGen request failed" is an `HttpError` with status 0, which gives NETWORK_ERROR).
- Docs: EN and VI `catalog.md` match each other and the code. `for-ai-agents.md` already lists
  JOB_FAILED under exit 5. The docs do not cover user-initiated cancels (M1) or explicit operation ids (M5).

## Recommended actions
1. H1: let the MiniMax `ProviderJobFailedError` reach `finalizeRun`, and test it through the generator.
2. M2/M4: pass `terminal: false` for HeyGen `waiting_for_input` and the TopView success-without-usable-output throws.
3. M3: mark `TopviewPredictionError` with `terminal: status !== "payment_required"`.
4. M1/M5: decide the cancel and explicit-operation-id semantics, then fix or document them (EN and VI).
5. Add `completeJobs` batch tests and real-path tests for Gemini omni.

## Unresolved questions
- Should a user-requested cancel (`replicate cancel`, `sume cancel`) count as failed, canceled, or be
  left out of the success rate?
- Is JOB_FAILED meant to be sticky across different provider jobs under one explicit operation id?

Status: DONE_WITH_CONCERNS
Summary: Classification design and most throw sites are correct, and lint/typecheck/tests/check:mcp pass. The MiniMax fix has no effect in production (the error is flattened to a string), and the sticky JOB_FAILED rule misreports user cancels, HeyGen pauses for input and TopView success-without-usable-output.
Concerns/Blockers: H1 should be fixed before claiming #473 covers MiniMax; M1/M5 need a product decision.
