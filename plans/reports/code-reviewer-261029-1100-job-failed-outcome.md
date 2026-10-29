# Code review: JOB_FAILED overrides an ok submit in operation outcomes (#471)

Scope: uncommitted diff in `src/catalog/usage-aggregate.ts`,
`tests/unit/catalog/usage-aggregate.test.ts`,
`docs-site/src/content/docs/commands/catalog.md` and the VI copy (about 60 LOC).

Checks: `vitest run tests/unit/catalog/usage-aggregate.test.ts` passes (35/35),
`biome check` is clean on the touched files, `tsc --noEmit` is clean. Classifier
behaviour was probed by running `TEXT_RULES` from `src/core/error-classify.ts`
against the real error and log strings in `src/providers/**`.

## Verdict

The code does what the issue describes, and the transient-poll cases stay
correct. JOB_FAILED cannot come from an HTTP-status error: `codeFromHttp` never
returns it, and status 0 maps to NETWORK_ERROR or TIMEOUT. NETWORK_ERROR and
TIMEOUT polls under an ok submit still count as completed, and the existing
tests at lines 241, 331 and 366 cover that.

Two concerns limit how much the change actually fixes, and one is a behaviour
regression.

## High

### H1. Most provider job failures are not classified JOB_FAILED, so the bug in #471 remains for them
The fix only works when `error.code === "JOB_FAILED"`. Terminal job failures
reach the ledger through `classifyError`, then `classifyMessage`, then
`TEXT_RULES`. The JOB_FAILED rule
`(task|job|prediction|generation|request) (failed|was canceled|errored)|status: ?failed`
needs the noun and the verb next to each other, so the real messages miss it:

| Source | Message | Code |
|---|---|---|
| `replicate/client.ts:52` | `Replicate prediction abc failed: …` | UNKNOWN |
| `atlascloud/client.ts:56` | `Atlas Cloud prediction p1 failed: …` | UNKNOWN |
| `topview/errors.ts:50` | `TopView video task t1 failed…` | UNKNOWN |
| `runway/client.ts:69` | `Runway task t1 failed…` | UNKNOWN (CONTENT_BLOCKED when SAFETY) |
| `minimax/client.ts:108` | `Task <id> failed: {…}` | UNKNOWN |
| `heygen/jobs.ts:320` | `HeyGen video v1 ended with status "failed"…` | UNKNOWN |
| `leonardo/byteplus/openrouter` logs, cloudflare `video generation failed` | `Task failed:` / `Job failed:` / `Generation failed:` | JOB_FAILED |

Example: `replicate run --no-wait` (ok, op `replicate:<id>`) followed by
`replicate status <id>` on a failed prediction (UNKNOWN, same op) still counts
as **completed**. The same happens for Atlas, TopView, Runway, MiniMax and
HeyGen.

Fix: classify by error type rather than by message text. Give the provider
"job ended failed" errors (`ReplicatePredictionError`, `RunwayTaskError`,
`AtlasPredictionFailedError`, `TopviewTaskError`, `HeygenJobFailedError`, the
MiniMax task failure, `PollFailedError`) a shared marker such as
`MultixError` code `JOB_FAILED` and map it in `classifyError`. Add one
regression test per provider error class. If that is out of scope for #471,
open a follow-up issue and say in the PR and the docs that only JOB_FAILED
classified runs override.

## Medium

### M1. A job that failed and was then resubmitted under the same `MULTIX_OPERATION_ID` now counts as failed for good
`operationIdFor` (`src/budget/cost-receipt.ts:241`) uses
`MULTIX_OPERATION_ID` before the provider id. The docs
(`reference/for-ai-agents.md:234`) present one id spanning resubmits ("only
each distinct paid submit (a resubmit is billed again) adds its cost").

Sequence: submit (ok), then status JOB_FAILED, then a resubmit under the same id
(ok), then status (ok). The old rule reported **completed**. The new rule
reports **failed** because `ops.some(isJobFailure)` ignores order.

Legacy and default ids are per provider job, so this only affects explicit ids.
It is still a silent change to a documented contract, and no test covers it.

Options:
- (a) Order-aware: the latest run among {JOB_FAILED, ok charge-role runs}
  decides. Status reads (`role: "observation"`) after a JOB_FAILED must not
  flip it back, because `fal status` exits 0 for a FAILED job.
- (b) Keep the new rule and document that an explicit id spanning a failed job
  and its resubmit counts as failed.

This is a product decision. Ask the issue owner.

### M2. A network failure is logged as `Generation failed: <msg>` and classified JOB_FAILED
`src/providers/gemini/commands/generate.ts:124` logs
`Generation failed: fetch failed` (and `socket hang up`), then calls
`process.exit(1)`. `finalizeRun` classifies `lastErrorLine`, and the
JOB_FAILED rule runs before NETWORK_ERROR, so the transient failure is
recorded as JOB_FAILED.

This does not change outcomes today. That run is synchronous and has no
provider id, so it is its own `run:<id>` operation and was already "failed". It
does change outcomes once it shares an op id (explicit
`MULTIX_OPERATION_ID`): a later ok run can no longer rescue the operation.
This classifier problem existed before the diff, but the diff makes it matter.

Fix (separate issue per AGENTS.md): check the transport rules (NETWORK_ERROR)
before JOB_FAILED, or have the command rethrow the error object so
`classifyError` sees the HttpError.

## Low

- L1. Tests: there is no case for JOB_FAILED plus a NETWORK_ERROR or TIMEOUT
  poll in the same op, and no TIMEOUT poll case at all. The issue explicitly
  says TIMEOUT must not fail the job. There is also no test that pins the M1
  order behaviour. The new test is otherwise good: it would fail on the old
  code, covers legacy and receipted ids, and checks that every grouping agrees.
- L2. The docs and the JSDoc say "a status poll that failed on its own (network
  error, timeout) is not a failure". The code actually ignores **any**
  non-JOB_FAILED failure when an ok run exists, including the UNKNOWN-classified
  provider failures in H1. The wording is narrower than the behaviour. The EN
  and VI docs match each other.
- L3. The `UsageRow.failed` / `completed` comments are correct. Lines may need
  re-wrapping for Biome if they are later moved, but Biome is clean today.

## Edge cases checked
- HTTP paths: JOB_FAILED is never produced from HttpError (`codeFromHttp`).
  HeyGen status 0 (`HeyGen request failed…`) is a `HeygenApiError extends
  HttpError`, so it becomes NETWORK_ERROR. Replicate, Runway, Sume and TopView
  use `request for X failed (status)`, which does not match.
- Poll helpers: byteplus, leonardo and openrouter only log `Task/Job failed`
  on `PollFailedError` (a provider terminal state). Other errors are rethrown
  and classified by type.
- Ordering: `ops.some` ignores timestamps; see M1.

## Plan follow-ups
- #471's stated rule is implemented, tested and documented (EN and VI).
- Before calling the issue fixed, decide H1 (scope) and M1 (contract).

Status: DONE_WITH_CONCERNS
