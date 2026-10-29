# Code review: count a JOB_FAILED status run as a failed operation (#471)

Commit: c765c7e on claude/relaxed-clarke-m00f02 (based on origin/dev)
Files: src/catalog/usage-aggregate.ts, tests/unit/catalog/usage-aggregate.test.ts,
docs-site/src/content/docs/commands/catalog.md, docs-site/src/content/docs/vi/commands/catalog.md
(+92 / -25)

## Verification run
- `npx vitest run tests/unit/catalog/usage-aggregate.test.ts`: 37/37 pass
- `npx biome check` on the two TS files: clean
- `npx tsc --noEmit -p .`: clean
- Probe: classified each provider's terminal-failure message with `classifyError(new ProviderError(msg))`
  through a temporary test file (deleted afterward; working tree unchanged).

## Overall
The aggregation change itself is small, correct for what it states, and the tie-break
reuses the existing timestamp-then-ledger-order rule. The weak point is the premise. The
fix depends on status runs recording `error.code: "JOB_FAILED"`, and most providers'
terminal job failures do not produce that code. For those providers the #471 bug is
unchanged, while the new docs and comments say it is fixed.

## High

### H1. Most providers' terminal job failures are not recorded as JOB_FAILED, so #471 stays open for them
`JOB_FAILED` has only one source: the text rule in `src/core/error-classify.ts:173-176`
(`/(task|job|prediction|generation|request) (failed|was canceled|errored)|status: ?failed/i`).
That rule needs the noun and the verb next to each other. Provider error classes put the
job id between them, so the rule does not match. Probe output (classifyError → code):

| Provider status command | Message shape (source) | Recorded code |
|---|---|---|
| replicate | `Replicate prediction <id> failed: ...` (replicate/client.ts:52) | UNKNOWN |
| atlascloud | `Atlas Cloud prediction <id> failed: ...` (atlascloud/client.ts:56) | UNKNOWN |
| runway | `Runway task <id> failed [CODE]: ...` (runway/client.ts:69) | UNKNOWN / INVALID_INPUT (text-dependent; "unexpected" hits the INVALID_INPUT rule) |
| sume | `Sume job <id> failed ...` (sume/client.ts:103) | UNKNOWN |
| topview | `TopView <kind> task <id> failed ...` (topview/errors.ts:50) | UNKNOWN |
| gemini video-status | `Gemini Omni interaction <id> failed ...` (gemini/omni.ts:319) | UNKNOWN |
| heygen | `HeyGen <kind> <id> ended with status "failed" ...` (heygen/jobs.ts:320) | UNKNOWN |
| byteplus / leonardo / openrouter | `Task failed:` / `Generation failed:` / `Job failed:` (logger.error lines) | JOB_FAILED |
| cloudflare | `Cloudflare video generation failed` | JOB_FAILED |

So in the issue's own scenario (ok submit, then a status run on a provider-failed job),
7 of the 11 providers with a failing status command still report the operation as
**completed**. `operationOutcomes` ignores the UNKNOWN status run because it is neither ok
nor JOB_FAILED, and the ok submit decides the outcome. The new doc text ("the provider's own job failure
(`JOB_FAILED`) decides") and the `isJobFailure` comment describe a guarantee that holds
only for byteplus, leonardo, openrouter and cloudflare. The tests build ledger rows with a
hand-written `error.code: "JOB_FAILED"` and a `fal status` command. `fal status` never
fails on a provider job failure (src/providers/fal/commands/status.ts only prints the
queue status), so no test checks that a real status command produces the code.

Fix (one of these):
- Preferred: classify provider job-failure errors structurally in `classifyError`. For
  example, give `ReplicatePredictionError`, `AtlasPredictionFailedError`, `RunwayTaskError`,
  `SumeJobError`, `TopviewTaskError`/`TopviewPredictionError`, `HeygenJobFailedError` and the
  Gemini interaction failure a shared marker (a `MultixError` code such as `JOB_FAILED`, or a
  common subclass), and map it to `JOB_FAILED` before the text fallback. Add one
  classify test per error class. This changes `src/core/error-classify.ts`, which the Worker
  also uses, so it needs `npm run check:mcp`. It may belong in its own issue per AGENTS.md
  ("open a new issue rather than widening the PR"). If so, #471's PR should not claim the
  whole fix: narrow the docs, or keep #471 open and link the new issue.
- At minimum: widen the regex to allow an id between the noun and the verb
  (e.g. `(task|job|prediction|generation|interaction)\b[^\n]{0,80}?\b(failed|canceled|cancelled|errored)\b`)
  and add classify tests for each provider message shape above. Watch for H2-style false
  positives.

## Medium

### M1. "request failed" is classified as JOB_FAILED, so a transient failure reported only in text can now fail a job
The same rule counts `request failed` as JOB_FAILED, and it runs before the
NETWORK_ERROR rule. Probe: `Request failed: fetch failed` and `request failed: ECONNRESET`
→ JOB_FAILED. Before this change the misclassification did not matter, because any ok run
still won. Now such a run decides the outcome as failed. Current HTTP paths avoid this:
`HttpError` (including HeyGen status 0) goes through `codeFromHttp` → NETWORK_ERROR, and
messages containing `HTTP nnn` take the HTTP branch. But any command that logs
`... request failed: <network text>` and exits through the `lastErrorLine` path
(agent-runtime.ts:237) would turn a transient poll into a job failure. That contradicts the
documented "network error, timeout ... is not a failure of the job". Fix: remove `request`
from the JOB_FAILED noun list (a request failing is not a job failing), or move the
NETWORK_ERROR rule ahead of JOB_FAILED. Add a classify test for both strings.

### M2. With "latest decisive run wins", a later read-only status poll that exits 0 turns a failed job back into completed
A status read without `--wait` exits 0 and is recorded `ok: true` even when it reports a
failed job. Examples: `byteplus status <id>` without `--wait/--download` prints
`status: "failed"` and exits 0 (byteplus/commands/status.ts:44-51). `fal status` always
exits 0. These runs share the operation id (`<provider>:<provider_id>`, cost-receipt.ts:250).
So `byteplus status --wait` (JOB_FAILED at T1) followed by `byteplus status` (ok at T2)
gives **completed**. The third new test ("lets a later successful run ... complete it after
JOB_FAILED") locks this in, but it does not name a real scenario where a provider id that
terminally failed later succeeds. The one legitimate case is a resubmission that shares an
explicit `MULTIX_OPERATION_ID`, and that resubmission has its own ok submit anyway.
Options:
(a) Keep latest-wins, but count an `ok` run as success only when it is not a pure status
observation (e.g. receipt `role !== "observation"`, or it produced outputs).
(b) Make JOB_FAILED sticky per provider id, and let a later ok run win only if it carries a
different provider id (a resubmission under an explicit operation id).
Either way, rename or rewrite the third test to describe the real scenario. This is a
product decision. Before the change, these operations were "completed" in every case, so this
is not a regression; it is a gap in the new rule.

## Low

### L1. per_success_usd interaction is untested
After this change a JOB_FAILED operation's spend stays in `known_usd`, but it leaves the
denominator of `per_success_usd` (usage-aggregate.ts:244). That is the intended "cost per
successful result" semantics, but no test checks it. A priced failed job with one priced
completed job should give `per_success_usd = (a+b)/1`. Also, an ok submit without a receipt
whose job later fails still counts in `unreceipted`, so `per_success_usd` becomes null.
That is conservative and acceptable, but undocumented.

### L2. Provider-side cancel counts as failed, not canceled
The regex maps `... was canceled` to JOB_FAILED, so a provider-reported cancellation
(where it matches) is now counted as **failed**. **canceled** is reserved for local
`CANCELLED` signals. The docs do not say this. Either note it, or map provider cancels
separately.

## Checked, no issue
- Ordering/ties: `latestOf` uses `b.ts >= a.ts`. Equal timestamps go to the later ledger
  entry, as before. ISO strings compare correctly.
- Cancel: a CANCELLED run is not decisive, so ok then CANCELLED is still completed (existing
  test at line ~415). A CANCELLED run with no decisive run is still canceled.
- Rows across groupings: outcomes are still decided once over all sent runs before
  grouping. The first new test checks every `USAGE_GROUPS` value, including the status row
  with no resolved model.
- Transient polls (NETWORK_ERROR) after an ok submit stay completed (existing tests at
  lines 259, 313). A failed poll with no provider id stays its own failed operation (#424 test).
- Docs: EN and VI edits match the code. No other docs still describe the old "any run
  succeeded" rule (grepped *.md/*.ts). Both say JOB_FAILED is "the provider's own
  failure", which is too broad (see H1).
- Lint, typecheck, and the targeted tests are clean. The `UsageRow` JSDoc is updated; the
  shape is unchanged (no contract break).

## Recommended actions
1. H1: make provider job-failure errors classify as JOB_FAILED, with per-provider
   classify tests. Or narrow the docs and comments, and track the gap in a linked issue.
2. M1: stop treating "request failed" as JOB_FAILED, or order NETWORK_ERROR first.
3. M2: decide whether an ok status observation may override JOB_FAILED, and fix or rename
   the third test.
4. L1/L2: add a per_success_usd test, and document provider-side cancel = failed.

## Unresolved questions
- Should H1 ship in this PR (it touches `error-classify.ts`, which the Worker shares) or
  in a separate issue linked from #471?
- What is the intended scenario for "later success after JOB_FAILED"? Is it only explicit
  `MULTIX_OPERATION_ID` resubmissions?
