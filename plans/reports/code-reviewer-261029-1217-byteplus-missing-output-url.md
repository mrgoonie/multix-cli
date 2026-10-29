# Code review: BytePlus succeeded task with no output URL (#510)

- Commit: f60bb94 (branch fix-510-local)
- Reviewer: isolated code-reviewer (did not author the change)
- Date: 2026-10-29 UTC

## Scope
- Files: src/providers/byteplus/generators/video.ts (helper `missingTaskOutputError`), commands/video.ts, image-to-video.ts, reference-to-video.ts, generate-3d.ts, status.ts; tests/unit/providers/poll-job-errors.test.ts
- LOC: +73 / -20
- Context read: src/core/error-classify.ts, src/core/errors.ts, src/core poll `toPollJobError`

## Verification run
- `npx vitest run tests/unit/providers/poll-job-errors.test.ts`: 38/38 pass
- `npm run typecheck`: clean
- `npm run lint` (biome): clean, 704 files
- Worker does not import `byteplus/generators/video`; the new `core/errors.js` import has no `node:*` deps, so the runtime-neutral rule holds.

## Correctness
- All five former `logger.error(JSON.stringify(final)) + process.exit(1)` sites now throw. Confirmed by grep: no `process.exit` or payload `JSON.stringify` remains on the output-URL paths in src/providers/byteplus.
- Each throw sits inside a `try` whose `catch` calls `toTaskWaitError`; `toPollJobError` returns non-poll errors unchanged (src/core/poll-job-error path, `return error`), so the ProviderJobFailedError reaches the top-level handler intact. Verified.
- Classification: `classifyError` maps a non-terminal ProviderJobFailedError via `classifyMessage`, downgrading JOB_FAILED to UNKNOWN. Message text "BytePlus task <id> succeeded but returned no ... URL" matches no text rule, so it lands on UNKNOWN (exit 1). The test asserts this.
- Test would fail on the old code: `runAndCatch` asserts `process.exit` was not called and the spy throws.
- `output` parameter is used in the message; no unused params.
- Message contains only the provider task id and a fixed noun; no prompt, signed URL, or key.

## Classification choice
UNKNOWN is correct versus alternatives:
- JOB_FAILED (exit 5) would claim the provider failed the job; it reported success.
- PROVIDER_UNAVAILABLE / NETWORK_ERROR (retryable, exit 4) would invite agents to resubmit a task that likely already billed: double charge.
- TIMEOUT / UNKNOWN_REMOTE_STATE do not fit: the task is finished.
This matches the documented intent of `terminal: false` ("finished but its output does not fit the next step") in errors.ts.

## Critical
None.

## High
None.

## Medium
1. Lost diagnostics with no recovery pointer. The old path dumped the payload (the leak being fixed), but now nothing about the response is surfaced at any log level, and the UNKNOWN hint says "rerun with --verbose for details", which shows nothing new here and, for video/i2v/r2v/generate-3d, "rerun" means resubmit and pay again. Suggest appending the inspection command to the message, e.g. `BytePlus task <id> succeeded but returned no video URL; inspect it with: multix byteplus status <id>` (status prints the full task JSON to stdout as its normal output), and/or `logger.debug` of the content key names only (not values). Non-blocking; the fix as-is meets the issue.

## Low
1. Test does not assert the payload is absent from log output. The regression in #510 was a log dump, yet the test only checks the thrown message. `console.error` and `process.stderr.write` are already mocked in `beforeEach`; asserting neither received PROMPT or SECRET_TOKEN would pin the actual bug. Note `status --download` still prints the whole status JSON to stdout before the throw: that is the command's intended output, pre-existing, not part of the error path.
2. Pre-existing `logger.error` + `process.exit` input-validation exits remain in generate-3d.ts (lines ~65, ~71) and reference-to-video.ts (~97). Out of scope for #510 (no payload, usage errors), but they bypass `classifyError` the same way; worth a separate issue per AGENTS.md rather than widening this PR.
3. `missingTaskOutputError` lives in generators/video.ts but is also used by the 3D command; consistent with `toTaskWaitError` already living there, so acceptable.

## Documentation impact
N/A is defensible: internal error-path change; no flag, command, or documented error code changed (UNKNOWN already documented). PR body should state this.

## Verdict
Approve. Medium 1 and Low 1 are recommended follow-ups, not blockers.
