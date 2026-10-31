# Code review: fal in-flight resume after a failure (#501)

- Scope: `git diff origin/dev...HEAD` (f142dfc, fd3e7f7, 5cd3e32, db63011), 12 files, +299/-25
- Base: origin/dev 309c6d5. Reviewer did not write this code.
- Checks run: focused vitest (finalize-run-cancel, fal commands, run-helpers, tts-command): 4 files, 123 tests pass. `biome check` on touched src: clean. Full build/test not run, as instructed.

## Verdict

The core fix works for the case in the issue: a transient failure (429, network, timeout, failed download) after fal accepted the job now gives `retryable: false`, puts the resume command first and drops `multix rerun`. The signal path behaves as before. The partial-outputs logic is gated correctly: `partial` requires `!inFlight` (agent-runtime.ts:328), and only `gemini generate` sets `run.partial`, which never tracks a job. The worker does not import `run-helpers.ts` or `request-receipt.ts`; grep finds only `src/providers/fal/speech-models.ts` under fal in worker/src. Shell quoting of the model, id and output dir is correct.

The weak spot is the rule for deciding that the provider ended the job. It only matches a `ProviderJobFailedError` or `JOB_FAILED`, and fal never produces either one. So fal's own job failures are now reported as "accepted, billed, do not rerun; resume", and that resume cannot succeed. No blocking defect, but the High item below should be fixed or explicitly accepted before merge.

## Blocking

None.

## High

### H1. fal job failures are reported as resumable billed jobs, and rerun/fix-input advice is suppressed
- Code: src/agent/agent-runtime.ts:235-241 (`jobEndedByProvider`) and :267-280; src/providers/fal/run-helpers.ts:190 and :196-200.
- fal's queue reports a failed request as `status: "COMPLETED"` with `error`/`error_type` fields. This is from the fal queue docs at fal.ai/docs/model-apis/model-endpoints/queue. `waitForFalResult` ignores those fields (`FalStatusResponse` in types.ts does not even declare them), stops polling at COMPLETED, and then the result fetch fails with an HTTP 4xx/5xx (for example a 422 for a runtime input validation error, or a 5xx for a model crash). That error is wrapped in a plain `Error` whose cause is an `HttpError`, so it classifies as `PROVIDER_REJECTED`/`INVALID_INPUT`/`PROVIDER_UNAVAILABLE`, never `JOB_FAILED`. `jobEndedByProvider` therefore returns false.
- Result:
  - The original hint ("Change the input…", "Fix the flagged input") is replaced with "accepted before the run failed; it runs on (or has finished) and is billed. Do not rerun".
  - `next[0]` is `multix fal result … --download`, which hits the same error again.
  - The rerun is removed.
  
  An agent following the envelope will loop on `fal result` and never fix the input. The "billed" claim is also unproven for a failed request. The new test at tests/unit/providers/fal/commands.test.ts ("fal image (submitAndWait)…", status 400 on poll) locks in this behaviour for a non-transient 4xx.
- The same mechanism hits paths that the broader rule newly covers:
  - Atlas: the content-safety block and "returned no outputs" in deliverPrediction (src/providers/atlascloud/commands/prediction-runner.ts:351-356) throw a plain `ProviderError`. Those runs now get "do not rerun; resume", the resume returns the same empty prediction, and the CONTENT_BLOCKED hint is lost.
- Fix options, smallest first:
  1. Apply the in-flight override only when the classified failure is one that resuming can fix: RATE_LIMITED, NETWORK_ERROR, PROVIDER_UNAVAILABLE without a body verdict, TIMEOUT, UNKNOWN (failed download / exit 1), INVALID_KEY/MISSING_KEY (fix the key, then resume), and CANCELLED. For PROVIDER_REJECTED, INVALID_INPUT, CONTENT_BLOCKED, NOT_FOUND and QUOTA_EXCEEDED, keep the original hint and append the resume command to `next` instead of overriding.
  2. In addition, have `waitForFalResult` read `error`/`error_type` from a COMPLETED status and throw a `ProviderJobFailedError` (terminal), so `jobEndedByProvider` sees fal's own verdict.
  3. Whichever option is chosen, do not replace `info.hint` wholesale. Prefix the do-not-rerun sentence and keep the class hint (for example `multix check` guidance for INVALID_KEY).

## Medium

### M1. The hint override discards actionable guidance for every class
- src/agent/agent-runtime.ts:274-280: `hint` is replaced, not composed. For example, a 401 on a status poll (INVALID_KEY) loses "run multix check / set FAL_KEY". `next` still has `multix check` after the resume, but the resume is listed first, which reads as "resume now", and resuming fails until the key is fixed. Same for a BINARY_MISSING from Atlas image finalisation after download. Compose the hint instead: "Job X was accepted…; do not rerun. <original hint> Then resume with the first command in next."

### M2. The docs overstate the scope (all providers) and the poll-429 trigger
- docs-site/src/content/docs/reference/for-ai-agents.md:104, :113 (and vi/ at the same lines); skill/SKILL.md:25.
- The text says that whenever "the provider accepted its job", `next[0]` resumes and no rerun is offered. Only fal run/tts/image/video (and `speech` routed to fal), Atlas (prediction-runner, `atlas status --wait`) and Sume `completeJob` call `trackInFlight`. Replicate, Runway, Leonardo, HeyGen, MiniMax, TopView and the others still offer `multix rerun` after an accepted job. An agent reading the docs will assume a rerun is never offered after acceptance. Name the covered commands, or state that this applies "when the command tracked the job (`job` names it)".
- "a 429 or network error on a status poll" does not happen as written for fal. Transient poll errors are retried until the deadline (run-helpers.ts:170-181) and surface as TIMEOUT. Only the result fetch and non-transient poll errors surface directly. This is minor, but the docs should match.
- "This does not apply when the provider itself failed or canceled the job" is false for fal in practice (see H1).
- The vi text is a faithful translation of the English for all three rows. No drift between the languages.

### M3. fal image/video resume ignores `--no-download`, `--output` and `--image-format`
- `submitAndWait` callers (src/providers/fal/commands/image.ts:62-67, video.ts:60) pass no `resume`, so the default `fal result … --download` is used.
  - With `fal image --no-download` (print URLs only), the resume downloads instead. This is the same mismatch db63011 fixed for `fal run`.
  - With `--output`, `--image-format` or `--no-webp`, the resumed files land in the default output dir without the copy or conversion.
- It does not cause a double charge, so it is not a correctness blocker. But it is inconsistent with the run/tts handling in this PR. Either pass a resume built the same way (download flag at least), or note in the hint that post-processing is not repeated.
- Likewise `speech generate --provider fal --output <file>` (src/commands/speech/speech-adapters.ts:309) resumes into the default dir and loses `--output`.

## Low

### L1. `resumeCommand` strips `--download` with a regex over an already-quoted string
- src/providers/fal/request-receipt.ts:76. The regex `/ --download(?= |$).*$/` can match inside a quoted argument. A model id `fal-ai/x --download y` becomes `multix fal result 'fal-ai/x` (unbalanced quote; verified by replicating the function in node). This is not exploitable: the result is a shell syntax error, not injection, and a model id with spaces would fail fal's submit before any job is accepted. It is still fragile, and it also silently drops `--format` and any later resultArgs.
- Cleaner: build the command from parts, `resultCommand(model, id, args, { download })`, instead of editing a rendered string. `fal result` without `--download` ignores `--format` today, so dropping it has no effect now.

### L2. Duplicated resume construction in run.ts:133-136 and tts.ts:133-136
- Both compute `receipt?.result_command ?? resultCommand(model, id)`. `receipt` is always set by `onAccepted` before `submitFalRequest` returns, so the fallback branch is dead code. It is harmless, but it is a second source of truth for the base command.

### L3. Test gaps
- No unit test for `resumeCommand`/`resultCommand` directly (quoting of the model/id/outDir, regex edge cases, extra args combined with `outputDir`).
- No finalizeRun test that a non-transient class keeps its advice. The suite currently asserts the opposite implicitly (commands.test.ts poll-400 case), so a fix for H1 needs a test with a 422 result fetch.
- No test for the Atlas/Sume behaviour change, which this PR broadens (deliverPrediction errors, download failures) even though those files are untouched.
- The finalize tests use `exitCode: 1` with no error for the "failed download" case, which matches `process.exit(1)` at run.ts:155 / image.ts:86. That case is adequately covered.

### L4. Exit code 4 alongside `retryable: false`
- A RATE_LIMITED failure with a job in flight exits 4 ("temporary") but `retryable: false`. The docs explain this at the exit-4 row, so it is acceptable. Calling it out because consumers that branch on the exit code alone will still rerun. SKILL.md does say "never resubmit", which mitigates this.

## Edge cases checked (no defect found)
- Failure before acceptance: `trackInFlight` is called only inside `waitForFalResult`, after `submitFalRequest` returns. The `submitFalRequest` checks that run after `onAccepted` (missing status_url/response_url, untrusted host) throw before tracking, so a rerun is still offered there. That is arguably wrong too, since fal did accept the job, but it is unchanged from before and out of scope. Consider a follow-up issue.
- `--detach` tracks nothing (covered by test).
- A download failure of a finished fal job: `process.exit(1)` gives UNKNOWN; the in-flight override applies and resume re-downloads with `--output-dir`. Correct.
- Signal exit: the wording is unchanged and `run.interrupted` is still used only when no job is in flight (agent-runtime.ts:281).
- `ProviderJobFailedError` with `terminal: false` (canceled/paused): the walk over the cause chain catches it even though the classification is not JOB_FAILED. Correct and tested.
- worker/ bundle: no import of run-helpers/request-receipt. `request-receipt.ts` keeps its `node:*` imports but is reachable only from CLI code.
- Concurrency: `run` is per-process module state. There is no cross-run leakage in the CLI, and the tests reset `inFlight` in afterEach.

## Recommended actions
1. H1: limit the override to failures that resuming can fix and/or map fal's COMPLETED+error status to a terminal `ProviderJobFailedError`. Add a 422 result-fetch test.
2. M1: compose the hint instead of replacing it.
3. M2: narrow the docs (en + vi + SKILL.md) to the commands that track jobs, and correct the poll-429 wording.
4. M3: pass a download-aware resume from fal image/video.
5. L1/L3: build the resume from parts; add direct unit tests for it.

## Unresolved questions
- Does fal bill a request whose status is COMPLETED with `error`? The fal docs page reviewed does not say. If it does not bill, the "is billed" wording is wrong for that case regardless of H1.
- Is the issue's "final 4xx on a status poll or result fetch" meant to include fal's own validation verdicts (a 422 from the result endpoint)? If it is, H1 becomes a product decision for the issue owner, not a defect.

Status: DONE_WITH_CONCERNS
Summary: The fix handles the reported transient-failure case correctly and safely. But the provider-ended detection never matches fal's own failures (COMPLETED with error, then a 4xx/5xx on result), so those runs get "do not rerun; resume" with a resume that cannot succeed and lose their fix-input advice; the same applies to Atlas content-safety and empty-output errors.
Concerns/Blockers: H1 should be fixed or explicitly accepted by the issue owner before merge; the docs overstate the scope to all providers.

## Resolution (author)

- **H1 fixed.**
  - The resume override now applies only to failures a resume can fix: `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR`, `TIMEOUT`, `UNKNOWN_REMOTE_STATE`, `MISSING_KEY`, `INVALID_KEY` and `UNKNOWN`. Every other code, including a 422 on the result fetch, keeps its own advice, and so does a `ProviderJobFailedError` anywhere in the cause chain.
  - `waitForFalResult` now throws a terminal `ProviderJobFailedError` (`JOB_FAILED`, carrying fal's own reason) when the status is `COMPLETED` with `error`. In that case it never fetches the result. This behaviour is confirmed by fal's queue docs (`error` and `error_type` fields on the status response).
  - Atlas's empty-output error is now a non-terminal `ProviderJobFailedError`. Its code is unchanged (`CONTENT_BLOCKED` or `UNKNOWN`), but it is no longer told to resume.
- **M1 fixed.** After a key error the hint says "fix the key, then resume" and keeps the original key advice.
- **M2 fixed.** The docs (English, Vietnamese and SKILL.md) now name fal, Atlas and Sume and the failures this covers, say that a rejected or failed job keeps its advice, and say that other providers still offer a rerun.
- **M3 partly fixed.**
  - `fal image` and `fal video` now pass `--no-download` through `submitAndWait`.
  - Still not carried over: `--output` and `--image-format` (`fal result` has no equivalent flags), and `speech --output`. The resume saves into the default output directory.
- **L1 fixed.** `resumeCommand(model, id, { extraArgs, outputDir, download })` now builds the command from its parts, with no regex.
- **L2 fixed.** The dead fallback was removed together with L1.
- **L3 fixed.** Added unit tests for `resultCommand`/`resumeCommand`, a test for 422 advice, a test for key advice, a test for fal COMPLETED-with-error, a test for `fal image --no-download`, and a test for Atlas empty output.
- **L4: accepted as documented.**
