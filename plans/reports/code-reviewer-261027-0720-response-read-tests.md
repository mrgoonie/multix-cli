# Code review: response-read tests (#358, PR #362)

Isolated reviewer (did not write the code). Scope: `git diff origin/dev HEAD`, i.e. the new
`tests/unit/core/response-read.test.ts` and `response-read.ts` added to `WORKER_SAFE_MODULES`
in `tests/unit/core/worker-safe-http.test.ts`.

Checks run: `npx vitest run tests/unit/core` (369 passed, 6 skipped), `npm run lint` (clean),
`npm run typecheck` (clean).

## Findings

| Sev | Where | Finding | Outcome |
|---|---|---|---|
| Medium | `response-read.test.ts`, Content-Length test | The body (20 bytes) also exceeded the cap, so the streamed-cap branch threw too and the test passed with the pre-check removed. | Fixed: the body now throws if it is read at all. Mutation check: with the pre-check disabled the test fails (`1 failed | 11 passed`). |
| Low | same file | No boundary case for `size === maxBytes`. | Fixed: "accepts a body of exactly the cap" (Content-Length 10, streamed 4+6). |
| Low | same file | `readCappedText` on a response with no body was not covered. | Fixed. |
| Low | same file | A `null` entry in an aggregate `errors` array was not covered. | Fixed: it is added to the existing case. |
| Low | idle-timeout test | Asserts the "no audio bytes" wording of a shared helper. | Kept: both callers are TTS, so a wording change should update the test. |

Determinism: after the first chunk the idle-timeout stream never enqueues or closes again, so
only the timer can end the read. A slow machine delays the test but cannot fail it. The
error-stream test rejects `read()` deterministically. The new file passed 3 out of 3 runs.

## Verdict

Approve once the Medium finding is fixed. It is now fixed, so there is no open blocker.
