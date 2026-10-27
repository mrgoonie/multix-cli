# Code review: Atlas signal handling before submit and in status --wait (#388)

Commit d701346 on `claude/gracious-heisenberg-h57sqj` (`git diff origin/dev...HEAD`, 13 files, +409/-65).

## Scope
- Source: src/agent/agent-runtime.ts, src/agent/run-state.ts, src/providers/atlascloud/commands/{prediction-runner,status,generation-command,output-claims}.ts
- Tests: tests/smoke/agent-mode.test.ts, tests/smoke/fixtures/fake-atlas-cdn-fetch.mjs, tests/unit/providers/atlascloud/prediction-runner.test.ts
- Docs: README.md, docs-site atlascloud.md (en, vi), skill/SKILL.md

## Verification run
- `npm run build`: ok. `npm run typecheck`: clean. `npm run lint` (biome): clean, 598 files.
- `npx vitest run` on the unit and smoke files: 61 passed, 1 skipped (the skip is an older schema-guard test, not new).
- The smoke tests with "signal" in their name, run 5 times in a row: 8/8 passed each time.
- Manual probes against a loopback server that never answers (script in the scratchpad):
  - `atlas run m/x --type image --no-validate --async --json` + SIGINT during the submit POST: exit 130, CANCELLED, retryable false, dashboard hint. Correct.
  - `atlas upload ref.png --json` + SIGINT during the upload POST: killed by the signal, no envelope (see Medium 2).
  - `atlas image "a cat" --json` (with schema validation) + SIGTERM during `GET /models`: killed by the signal, no envelope (see Medium 2).

## Overall assessment
The core change is correct. One `exitOnInterrupt` now covers the whole `executePrediction` lifecycle (uploads, submit, wait, download), and its message is updated as each phase starts. `status --wait/--download` records the id with `trackInFlight` before polling starts. SIGHUP is now handled in output-claims. The new `run.submit` branch in `finalizeRun` only runs when the exit is a signal exit (`signalled`), so failures that are not signals are classified exactly as before. I found no listener leak and no ordering bug. One real defect remains: the cost receipt contradicts the new hint.

## Critical Issues
None.

## High Priority

### 1. Submit cut off by a signal: the cost receipt says "settled $0, no request was sent", which contradicts the error hint
- Input: `multix atlas image "a cat" --no-validate --json`, then SIGINT/SIGTERM/SIGHUP while `POST /model/generateImage` has not been answered yet.
- Output (observed): `error.hint` says "the provider may have accepted it and will bill it ... you may pay twice". But in the same envelope, `cost` is `{"status":"settled","reason":"No provider request was sent.","actual_usd":0,"actual_source":"no_request"}`. `http` is also missing. The same receipt is written to the history ledger.
- Cause: `installFetchTelemetry` (src/agent/fetch-telemetry.ts:127-134) only adds an entry to `run.calls` after the fetch settles. A request still in flight at `process.exit` is counted in `requestsStarted` but never added to `calls`. `buildCostReceipt` (src/budget/cost-receipt.ts:165) then sees `sent.length === 0` and settles the run at $0. Before this commit the run was simply killed and produced no envelope. This commit is the first to emit an envelope in this state, so it adds the contradiction.
- Impact: an agent or spend summary that trusts `cost.status` gets "settled, $0, no request" for exactly the case the hint warns may be billed. `isNoSpend` also hides it from uncertain counts, so `uncertain` stays 0.
- The result also depends on whether `--ref` was used. With refs, the completed upload POSTs count as billable calls, so the receipt becomes "uncertain". Without refs it is "settled $0".
- Fix (minimal): in `costReceiptFor` or `finalizeRun`, when `run.submit?.sent && !run.inFlight`, add the unanswered submit as a cut-off call (`{ method: "POST", status: 0 }`). The receipt then goes through the existing "partial / failed after a billable request" branch and becomes `uncertain`. A more general fix: record `requestsStarted - calls.length` unanswered requests as `status: 0` calls when finalizing. That also fixes the generic `providerContacted` signal path for other providers. If you prefer the general fix, file it as a separate issue (AGENTS.md: unrelated bugs get their own issue). The Atlas-specific contradiction should still be closed in this PR, because this PR adds the hint.
- Test gap: the smoke test "a signal during the submit ..." checks `error` but not `cost`. Add `expect(out.cost.status).not.toBe("settled")`.

## Medium Priority

### 2. Atlas network calls still outside the guard: no envelope on a signal (gap that already existed, not a regression)
- `loadModelSpec` (`GET /models`) runs before `executePrediction` in both `runGenerationCommand` (generation-command.ts:41) and `atlas run` (run.ts:57). A signal there still triggers Node's default action. I observed this: exit by SIGTERM, empty stdout, no `multix.result/v1`. The request is free, so nothing is billed, but `--json` agents get no envelope and no history entry.
- `atlas upload` (upload.ts) has no handler either. Observed: exit by SIGINT, no envelope.
- #388 only asked for `--ref` uploads, so these are out of scope. Two options: wrap `loadModelSpec` in the same `exitOnInterrupt` (move it inside `runPrediction`, or wrap the whole action), or open a follow-up issue. The docs do not claim these paths are covered, so there is no doc inaccuracy.

### 3. "Clean cancel" hint after some uploads already finished
- Input: two `--ref` files; the signal arrives while the second upload is in flight.
- Output: `error.hint` = "The run was cancelled; nothing was left behind. Rerun the command." The first uploaded file is still on Atlas storage as a temporary URL. Because of the completed upload POST, the receipt is `uncertain` ("failed after a billable request").
- Nothing is billed, so the instruction "rerun is fine" is correct. But "nothing was left behind" is not literally true, and the receipt disagrees with the hint. Low risk. If you fix High 1 by synthesizing calls, also consider excluding `/model/uploadMedia` from billable calls so the receipt agrees with the hint.

## Low Priority
- `status <bad-id> --wait` + signal: the hint says "Job <id> was submitted before the run stopped; ... billed" even when the id does not exist (the first GET is still in flight). This is a cosmetic edge case.
- The `--async` path after a successful submit: there is a window of a few microseconds between `client.submit` resolving and `exitOnInterrupt` removing its listeners. In that window the message would still say "may have accepted" instead of giving the id. Not reachable in practice.
- `ATLAS_DASHBOARD` points to `https://www.atlascloud.ai/console`. The only URLs confirmed elsewhere in the repo are under `/console/api-keys`. I could not confirm that the console root lists predictions. Worth a one-time manual check.

## Edge cases from scouting (checked, no defect)
- **Listener ordering vs output-claims `once` listeners:** `exitOnInterrupt` registers with `process.on` before any download, and output-claims installs its `once` listeners later, on the first `tryLock`. On a signal, `stop` runs first: it writes the message, runs `cleanupActiveClaims`, then calls `process.exit`. The exit wrapper runs `finalizeRun` and then `realExit`, which is synchronous, so `handleInterrupt` never runs. Each process calls `executePrediction` / `status` only once (grep: run.ts:74, generation-command.ts:49), so the reverse order (output-claims first, which would print a stale message) cannot happen.
- **Listener leak:** `finally` removes all three listeners. The existing unit test checks that listener counts return to baseline. The output-claims `once` listeners stay for the process lifetime, as before, and now also cover SIGHUP.
- **Exit codes:** text mode uses `input.exitCode` (129/130/143). JSON mode uses `classifySignalExit().exit_code`, which gives the same values. Confirmed by smoke tests and by my probe.
- **Failures that are not signals** (HTTP 4xx/5xx, timeout, `AtlasPredictionFailedError`): `signalled` requires `input.error === undefined` and a signal exit code, so `run.submit` and `run.inFlight` are ignored. `run.submit` is never cleared, but that has no effect without a signal exit.
- **`--async`:** signal during the submit → the "may have accepted" hint. Verified by probe.
- **`status` without `--wait`:** unchanged; single GET, no handler.
- **`status --wait` failure:** `report()` still throws `AtlasPredictionFailedError` inside the guard. The error propagates after `finally`.
- **`--dry-run` with `--ref`:** the first fetch is still the upload, so the dry-run request shown is the upload, not the submit. This behaved the same before the change (uploads already came before the submit).

## Test reliability
- The smoke tests synchronize on "request reached the server" (`seen.reached`) and on a marker file, not on sleeps. Handlers are installed synchronously before the matching fetch, so there is no window where the request has been sent but no handler exists. The download test polls the marker with a deadline and then asserts. If the marker never appears it fails cleanly instead of hanging.
- The unit tests call `process.listeners(signal).at(-1)`. This depends on `exitOnInterrupt`'s listener being registered last, which holds because earlier download tests leave the output-claims `once` listeners registered first. The existing wait test documents the same assumption. It works, but it is brittle if test order changes. Acceptable.
- The unit tests do not cover the new `finalizeRun` `run.submit` branch directly. The smoke tests cover it end to end.

## Doc accuracy
- README, docs-site en/vi, and SKILL.md match the code: 129/130/143; the guard covers both waiting and downloading, in generation commands, `atlas run` (via `executePrediction`) and `status --wait/--download`; the unfinished download is removed; uploads are a clean cancel; a cut-off submit gets the dashboard hint and `retryable: false`.
- The Vietnamese text is equivalent to the English.
- Nothing documents the cost receipt for this case. That is consistent, but see High 1.

## Recommended actions
1. Fix the receipt for a submit cut off by a signal so it is `uncertain` and not `settled $0 / no_request`, and assert this in the smoke test (High 1).
2. Open a follow-up issue, or extend the guard, for `loadModelSpec` and `atlas upload` signals that produce no envelope (Medium 2).
3. Optional: reword the upload-cancel hint, or make the receipt agree with it when earlier uploads finished (Medium 3).

## Plan / task status
#388's acceptance criteria are met: uploads → CANCELLED; submit in flight → CANCELLED with the dashboard hint; `status --wait/--download` → 128+n with the resume command at `next[0]` and the id in `provider_ids`; SIGHUP during a download → cleanup and exit 129. The receipt contradiction (High 1) is a defect next to that scope, introduced by the new envelope.

## Metrics
- Typecheck: 0 errors. Lint: 0 issues. Affected tests: 61 passed / 1 skipped (skip not new).

## Unresolved questions
- Does `https://www.atlascloud.ai/console` show a prediction list where a user can find an orphaned submit?

Status: DONE_WITH_CONCERNS
Summary: The signal handling is correct and well tested: no ordering bug, no listener leak, correct exit codes, and docs that match the code. However, the envelope for a submit cut off by a signal carries a cost receipt saying "settled $0, no request was sent", which contradicts its own "may have been billed" hint.
Concerns/Blockers: High 1 (receipt contradiction) should be fixed or explicitly deferred to its own issue before merge; Medium 2 is a follow-up gap that already existed.
