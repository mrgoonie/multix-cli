# Review: job id past the cap and fal result naming its job (#477)

Commit fc323d7. `npx vitest run tests/unit/agent tests/unit/catalog`: 284/284 pass.

## Correctness
- Cancel and resume hints are unchanged. `agent-runtime.ts:240-298` reads only `run.inFlight`, and `inFlight` still comes before `namedJob` in `jobIdentity`.
- Cap bound: fetch adds at most 11 ids. The one past the cap is allowed only while no recorded id came from a successful non-upload submit, so it cannot happen twice. `nameJob` and `trackInFlight` add ids outside the cap, so the total can reach 12.
- Low: the extra slot goes to the first new id. Body ids come before header ids (`usage-extract.ts`), so the slot is the job id unless another ID_KEY comes first in the body.
- A run can be labelled wrongly. `nameJob` runs before the GET, so a mistyped `requestId` (404, or a network error with status 0) still reports `job` and `operation_id fal:<arg>`. The argument also goes into `provider_ids` unchecked and unbounded.

## Usage outcomes
A failed `fal result` now joins `fal:<id>`. When the submit was ok (`--detach`), the operation reads as completed. That matches the rule that a failed poll is not a failure. Trade-off: a job that fails at fal and is seen only by `result` is never counted as failed.

## Docs
The `job` rows in EN and VI still say "when a successful provider response returned an id". A named job is reported even after a failed read, so the rows should say so.

## Tests
The fal test calls `nameJob` directly and does not run `result.ts`, so it does not prove the wiring. Missing tests: a failed read that still names the job, and a submit before the cap that gets no extra slot.

## Follow-up (not blocking)
These commands have the same gap: a failed read leaves no id, so it becomes its own `run:` operation. `fal status`, `replicate status`, `runway status`, `leonardo status`, `byteplus status`, `topview status`/`prediction`, `gemini video-status`, `cloudflare video-status`. Cancel commands need a separate design: an ok cancel that joins the operation marks it completed.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct and the cap is bounded (at most 11 ids from fetch). Concerns: `namedJob` labels failed or mistyped reads, which contradicts the `job` docs; the fal test bypasses `result.ts`; several status and cancel commands share the gap.

## Resolution (author)
- Wrong labels: kept by design. A failed `fal result` read of the given job now joins that job's operation, the same way a failed poll does. `nameJob` ignores an argument longer than 128 characters, the same bound used for ids taken from responses. A mistyped id gets its own operation, which is the same result as before (one failed operation).
- Docs: the `job` rows (EN and VI) now say that the given job is named even when the read fails.
- Tests: the fal case now runs `result.ts` through commander, and it fails if the `nameJob` call is removed. Tests were added for a failed read that keeps the named job and rejects an over-long argument, and for a submit before the cap getting no extra slot.
- Cap: at most 11 ids from responses, plus ids that commands name themselves, as the review describes. No change.
- Follow-up: the other status and result readers, and the cancel design, are filed as #489.
- Gates: lint, typecheck and build pass. The full suite passes (2825 passed, 22 skipped), and verify:docs passes.
