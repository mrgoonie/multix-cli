# Code review: TopView payment_required classification and Gemini generate error propagation (#483)

- Commit: `acbbbd3` on `claude/relaxed-clarke-k1jv4l`, diff vs `origin/dev`
- Reviewer: isolated code-reviewer agent (did not write the change)
- Date: 2026-10-29 (UTC)

## Scope

- `src/core/error-classify.ts` (1 line: `payment required` -> `payment[ _]required` in the QUOTA_EXCEEDED rule)
- `src/providers/gemini/commands/generate.ts` (catch + `logger.error` + `process.exit(1)` removed; the error now propagates)
- `tests/unit/core/error-classify.test.ts` (+9), `tests/unit/providers/gemini/generate-errors.test.ts` (new, 77)
- Read for context: `src/agent/agent-runtime.ts` (`captureStreams`, `finalizeRun`, `exitWithError`), `src/cli.ts`, `src/providers/gemini/key-pool.ts`, `src/providers/topview/errors.ts`

## Overall assessment

Correct, minimal, cause-aligned. Both root causes from the issue are confirmed and fixed. No blocking findings.

## Verification performed

| Check | Result |
|---|---|
| `npx vitest run tests/unit/core/error-classify.test.ts tests/unit/providers/gemini` | 14 files, 252 tests passed |
| `npx biome check` on the 4 touched files | clean |
| `npx tsc --noEmit -p .` | clean |
| Built `dist/cli.js` from HEAD (scratch worktree), `fetch` stubbed to throw `TypeError("fetch failed")` | text mode: prints `Error: HTTP 0 from ...: fetch failed`, `code: NETWORK_ERROR`, exit 1; `--json`: envelope `error.code=NETWORK_ERROR`, `exit_code: 4`, retryable |
| Same, `--num-images 2`, 1st call 200 with image, 2nd call HTTP 400 body `payment_required` | `QUOTA_EXCEEDED`, `http_status: 400`, exit 5; first image stays on disk |
| `git merge-tree --write-tree HEAD origin/claude/relaxed-clarke-m00f02` | clean merge (no conflicts) |
| Merged tree: error-classify, gemini, topview unit tests | 19 files, 375 tests passed |
| Merged tree: `classifyError(new TopviewPredictionError({status:"payment_required"}))` | `QUOTA_EXCEEDED` (non-terminal path -> `classifyMessage` -> QUOTA rule) |
| Merged tree: `TopviewPredictionError` with `status:"failed"` | `JOB_FAILED` (terminal) |

## Root-cause confirmation

1. On `origin/dev`, the TopView payment message contains `payment_required` (no space), so the QUOTA rule missed, and the later INVALID_INPUT rule matched on `required`. Fixed by the regex widening.
2. On `origin/dev`, `generate.ts` logged `✗ Generation failed: <msg>` then `process.exit(1)`. The patched `process.exit` calls `finalizeRun({exitCode:1})` with no error, so the run was classified from `run.lastErrorLine` = `Generation failed: ...`. When the message had `HTTP NNN` (3 digits) `classifyMessage` still used the HTTP path, but network failures (`HTTP 0 ...`, single digit, no match) and non-HTTP errors fell through to the JOB_FAILED text rule (`generation failed`). Now the error reaches `cli.ts` -> `exitWithError` -> `finalizeRun({error})` -> `classifyError`, which honours `HttpError.status`.

## Critical issues

None.

## High priority

None.

## Medium priority

None introduced by this change.

## Low / informational

1. **[Low, pre-existing] Partial success on `--num-images > 1` is not reported.** If request 2 fails after request 1 saved an image, the envelope has `outputs: []`, `cost.status: "uncertain"`, and `next` suggests switching provider, while a paid image sits in the output dir (only visible in the envelope `text` as `✓ Saved: ...`). Behaviour is identical to `origin/dev` (old code also exited inside the loop), so not a regression. Candidate for a separate issue (report saved files on failure, or stop after partial success).
2. **[Low] Regex widening scope.** `payment[ _]required` now also applies to HTTP bodies via `codeFromHttp` (4xx bodies refined by text) and to any logged line. Any body carrying `payment_required` / `PAYMENT_REQUIRED` (Stripe-style code) means a billing failure, so QUOTA_EXCEEDED is the right reading; no false-positive found in `src/`. Rule order unchanged: CONTENT_BLOCKED, MISSING_KEY, INVALID_KEY still win when they match first.
3. **[Info] Key pool unaffected.** `withGeminiKey` rotates only on `HttpError` 429 / RESOURCE_EXHAUSTED and rethrows everything else; the removed catch was outside it, so rotation and cooldowns behave as before. The "All N keys are rate-limited" warning is `⚠`, not an error line, so it does not set `lastErrorLine` and the `Error:` line is still printed in text mode.
4. **[Info] Sibling catch-and-exit patterns remain** (same class of bug, out of scope for #483): `src/providers/fal/commands/result.ts:57` (`Failed to fetch result ...: ${msg}`), `src/providers/minimax/commands/image-to-image.ts:104`. Consider a follow-up issue rather than widening this PR.
5. **[Info] Tests.** `generate-errors.test.ts` asserts the error escapes as itself (not a `process.exit` throw), classifies as NETWORK_ERROR / PROVIDER_REJECTED with `http_status`, and the `Generation failed` line is gone: real behaviour, not phantom. It restores env and mocks in `afterEach`. The TopView test uses the real message text from `predictionFailureMessage`. No test covers the text-mode `Error:` print path, but `exitWithError` is shared and was verified manually above.

## Composition with `origin/claude/relaxed-clarke-m00f02`

- Textual: clean three-way merge (the m00f02 change moves the JOB_FAILED rule above CONTENT_BLOCKED and adds the `ProviderJobFailedError` branch; this change edits only the QUOTA line).
- Semantic: m00f02 makes `TopviewPredictionError` a `ProviderJobFailedError` with `terminal: status === "failed"`. For `payment_required` it calls `classifyMessage(message)`. The payment message has no `<noun> [id] failed|errored|was canceled` and no `status: failed`, so the moved JOB_FAILED rule does not match, and the widened QUOTA rule yields `QUOTA_EXCEEDED` (verified on the merged tree). Without this change, the merged branch would still give INVALID_INPUT for payment_required, so the two are complementary.
- The old Gemini log line `Generation failed: ...` would also match m00f02's JOB_FAILED rule (`generation failed`), so removing the log line here is needed for Gemini regardless of merge order.

## Edge cases checked

- Thrown error printed to user: yes (`Error: <message>` in text mode when no earlier error line; `error` object in JSON envelope).
- Exit code: text mode exit 1, JSON `exit_code` per class (4 network, 5 quota), consistent with existing `exitWithError` convention.
- Validation errors earlier in the action already threw `ValidationError`; behaviour unchanged.
- `No images were generated` path (all responses empty) still logs and `process.exit(1)` -> classified from text (UNKNOWN). Unchanged, acceptable.

## Recommended actions

1. Merge as is.
2. Optional follow-up issues: partial-success reporting for `gemini generate --num-images`; fal `result` and minimax `image-to-image` catch-and-exit.

## Plan follow-ups

No plan file. Issue #483 acceptance (payment_required -> QUOTA_EXCEEDED; Gemini generate classified by its own error) is met.

## Unresolved questions

None.
