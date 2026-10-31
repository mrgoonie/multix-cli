# Code review: fal wait errors keep their cause (#495)

Date: 2026-10-29 (UTC). Branch `claude/relaxed-clarke-r1ofyx`, base `origin/dev`, uncommitted diff.
Reviewer: isolated code-reviewer (did not write the code). No source files modified.

## Scope
- `src/core/error-classify.ts` (+14): new branch in `classifyError` (lines 304-317)
- `src/providers/fal/run-helpers.ts` (+8/-2): `{ cause: e }` on both wraps (lines 167-169, 181-183) and doc comment
- `tests/unit/core/error-classify.test.ts` (+28), `tests/unit/providers/fal/run-helpers.test.ts` (+80)

## Verification run
- Focused tests: 56/56 pass (`vitest run` on both files).
- With only the two source files reverted (tests kept): 3 of the 5 new tests fail (both fal 429 tests and the classifyError wrap test), so they prove the fix.
- `npm run lint`: clean (700 files). `npm run typecheck`: clean.
- Before/after probe (scratch script, outer fal wrap around several causes):
  - HttpError 0, HttpError 400, ConfigError (`FAL_KEY is not set`), terminal ProviderJobFailedError: same code before and after. `env` (FAL_KEY) is still extracted. URL query strings are still redacted (`?[redacted]`).
  - ResponseTooLargeError: before `UNKNOWN`, after `RESPONSE_TOO_LARGE` (the fix is right).
  - HttpError 429 + Retry-After: before no `retry_after_s`, after `retry_after_s` is set (the issue being fixed).
- `check:mcp` was not run (worker/node_modules missing). No imports were added to `src/core/error-classify.ts`: it still imports only `./errors.js` and `./redact.js`, so there is no `node:*` exposure. The worker uses `classifyMessage` only (`worker/src/mcp-server.ts:17`), which is unchanged.

## Blast radius (did following `cause` misclassify other call sites?)
- Grep of `src/` and `worker/` for a plain `new Error(..., { cause })`: the only hits in production code are the two fal wraps (`src/providers/fal/run-helpers.ts:167,181`). Every other `{ cause }` wrap builds a MultixError subclass (ProviderError, HttpError, SumeApiError, TopviewApiError, ReplicateApiError, ...). Those return before the new branch or fail its `getPrototypeOf === Error.prototype` guard.
- Native errors that carry a cause (undici `TypeError("fetch failed", { cause })`, AbortError, DOMException) have a different prototype, and their cause is not a MultixError. They are not affected.
- `classifyError` callers are `src/agent/agent-runtime.ts:233` (finalizeRun, `input.error`) and `src/commands/scene/scene-render.ts:221`. Only an error thrown from `waitForFalResult` (fal `run`, `tts`, `image`, `video` via `submitAndWait`) reaches the new branch. No other path is affected.
- Recursion terminates: the cause is a MultixError, and a MultixError subclass never matches the plain-Error guard, so the recursive call is at most one level deep.

## Findings

### Blocking
None.

### High
None.

### Medium
**M1. The envelope tells agents to "retry the same command" after fal has already accepted (and will bill) the job. This is pre-existing; the change makes it more visible.**
`waitForFalResult` runs only after `submitFalRequest` succeeded (`src/providers/fal/commands/run.ts:111-127`). A 429, 5xx (on the result fetch) or network error there is classified `RATE_LIMITED`/`PROVIDER_UNAVAILABLE`/`NETWORK_ERROR` with `retryable: true` and the hint "Wait retry_after_s ... and retry the same command" (`src/core/error-classify.ts:84`). Rerunning `multix fal run` submits again and pays twice. The outer message carries the correct `Resume with: multix fal status|result ...` advice, but `hint`/`retryable` contradict it. The in-flight override in `finalizeRun` applies only when `input.error === undefined` (`src/agent/agent-runtime.ts:239-242`). Before this change the same codes were produced from the message text ("HTTP 429" goes through `codeFromHttp`), so this is not a regression. The new `retry_after_s` makes a blind retry more likely, though. This is out of scope for #495: per AGENTS.md, open a follow-up issue rather than widening this PR. Options: post-submit wait errors carry the request id so finalizeRun can set `retryable: false` plus the resume hint (as it already does for signals), or wrap them in a typed error.

### Low
**L1. The 401 test does not prove the change.** `tests/unit/providers/fal/run-helpers.test.ts` "classifies a 401 on the status poll as INVALID_KEY ..." also passes with the source fix reverted, because "HTTP 401" in the text already maps to INVALID_KEY. It is harmless as a guard, but its title implies it covers the new path. A case whose class differs between the text and the cause would pin the behavior better, for example a ResponseTooLargeError on the result fetch (UNKNOWN before, RESPONSE_TOO_LARGE after) or a 429 whose snippet mentions quota.

**L2. Classification uses only the cause; the outer text is ignored for the code.** If the cause is a generic MultixError (code PROVIDER_ERROR), the code comes from `classifyMessage(cause.message)`, not from the outer message. Today the outer fal text adds only the request id and the resume hint, and no TEXT_RULES pattern matches those, so the results are identical (verified by the probe). Future wrappers that put meaningful words in the outer text would not have them classified. It is acceptable and documented by the comment at `src/core/error-classify.ts:304-306`.

**L3. Only one level is followed.** `Error -> Error -> MultixError` is not unwrapped (probe "nested" gives UNKNOWN). No call site does this today, so no action is needed. Mentioned only so that no future double-wrap assumes it works.

**L4. The `http_status` rule differs slightly from the direct HttpError path.** That path sets `http_status: error.status || undefined`. The new branch copies the recursive result, so status 0 also stays undefined. Consistent; no action.

## Redaction / env extraction
- `build(code, message, ...)` still receives the outer message (`src/core/error-classify.ts:313`), so `redactUrlsInText` and `ENV_NAME` extraction run on the full text, which includes the cause's message. HttpError messages and snippets are already redacted at construction (`src/core/errors.ts:107-110`). `rawUrl` is non-enumerable, so attaching the HttpError as `cause` exposes no raw signed URL if the error object is inspected or serialized.

## Docs impact
None needed. No command, flag, or error code is added. `retry_after_s` is an existing envelope field that is now filled in for one more case.

## Plan / task status
Issue #495 acceptance (cause kept, 429 keeps `retry_after_s`, class mapping kept) is met and tested. Recommended next step: open a follow-up issue for M1.

## Unresolved questions
- Should post-submit wait failures be non-retryable in the envelope (M1)? This is a product decision for a separate issue.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct and narrowly scoped: only the two fal wraps reach the new branch, redaction and env extraction still work, there are no worker or `node:*` concerns, and lint, typecheck and the focused tests pass (the new tests fail without the fix). Concerns are non-blocking.
Concerns/Blockers: Pre-existing M1 (a retryable "retry the same command" hint after a paid fal job was accepted) should become a follow-up issue. The 401 test (L1) does not exercise the new path.
