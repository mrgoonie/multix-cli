# Code review: atlas signal resume (#378), commit c159ea4

Branch `claude/gracious-heisenberg-jiv0v9`, base `origin/dev`. Reviewer did not write the code.

## Scope
- Files: src/providers/atlascloud/commands/prediction-runner.ts, src/agent/agent-runtime.ts,
  src/agent/run-state.ts, tests/smoke/agent-mode.test.ts,
  tests/unit/providers/atlascloud/prediction-runner.test.ts, README.md, skill/SKILL.md,
  docs-site atlascloud.md (en + vi). 9 files, +207/-14.
- Read for context: output-claims.ts (handleInterrupt / once-listeners), client.ts
  (waitForPrediction), status.ts, generation-command.ts, run.ts, speech-adapters.ts,
  fetch-telemetry.ts (ids), stdin-file.ts and media-quality-commands.ts (other signal handlers).

## Verification run
- `npm run lint`: clean (594 files). `npm run typecheck`: clean.
- `npx vitest run tests/unit/providers/atlascloud/prediction-runner.test.ts`: 42 passed, 1 skipped.
- `npm run build` then the new smoke tests (`-t "signal while atlas"`) 3 times in a row: 3/3 passed each time.
- Composition with #375 (`origin/claude/gracious-heisenberg-13hxw2`):
  `git merge-tree --write-tree HEAD origin/claude/gracious-heisenberg-13hxw2` merges with no conflicts.
  Trial merge in a temp worktree under /tmp (deleted afterwards): typecheck clean, build OK,
  prediction-runner unit, tests/unit/agent, error-classify unit and agent-mode smoke: 8 files, 94 passed.
- Manual signal runs against the merged dist/cli.js with a fake Atlas server:
  - SIGINT --json: exit 130, `error.code` CANCELLED, hint is the inFlight hint (not "nothing was left
    behind", not #375's provider-contacted hint), `provider_ids: ["pred_x"]`,
    `next: ["multix atlas status pred_x --wait --download"]`.
  - SIGHUP --json: exit 129, same shape.
  - SIGTERM text mode: exit 143, stderr shows `code: CANCELLED (exit 143 with --json)`, the inFlight hint
    and `next: multix atlas status pred_x --wait --download`.
  The override runs after classification (including #375's `classifySignalExit`), so it wins after the merge.

## Overall assessment
Small, correct change. The listener is scoped to the wait, removed in `finally`, and it exits through
the wrapped `process.exit` so `finalizeRun` builds the envelope. The override is narrowly gated
(`info` present, no thrown error, exit code 129/130/143, and `run.inFlight` set), so non-signal failures,
timeouts (thrown `PollTimeoutError`) and successful runs keep their behaviour. `--async` returns before
`trackInFlight`, so nothing changes there. `executePrediction` is not exported from src/index.ts and no
worker code imports it, so the `process.on` / `run-state` dependency stays in the command layer (the
same pattern as other provider commands that import `run`). Every caller (atlas image/video/..., atlas run,
`multix speech` via the atlas adapter) goes through `executePrediction`, so all of them get the fix.

## Critical
None.

## High
None.

## Medium
None.

## Low

1. **The hint is also applied during the download phase, where "keeps running" is false.**
   `run.inFlight` stays set after the wait ends. A Ctrl-C while a finished prediction's outputs download
   runs output-claims' once-listener -> `handleInterrupt` -> `process.exit(130)` -> `finalizeRun`, which
   prints "Job X ... keeps running (it is billed)". By then the prediction has succeeded. The resume command
   is still the right action (it keeps saved files and fetches the missing ones), and it is better than
   #375's "Rerun the command", so the action is correct and only the wording is wrong.
   Fix: wording that fits both phases, e.g. "Job X was submitted before the run stopped and is billed
   (it may still be running). Do not rerun; resume it with the next command." Or update `inFlight` after
   the wait with a "finished, outputs not saved" variant.

2. **If this lands before #375, the text-mode code line is wrong.** Without #375, a signal exit is
   classified as UNKNOWN (`classifyMessage("Command exited with code 130")`). The text hint line prints
   `code: UNKNOWN (exit 1 with --json)`, but the JSON exit code for UNKNOWN is `input.exitCode` = 130.
   Also, if any earlier stderr line matched `Error:`/`✗` (`run.lastErrorLine`), JSON mode would report
   that line's class and exit code (e.g. 4) instead of 130, with the inFlight hint attached. Both issues
   are pre-existing and #375 fixes them (`classifySignalExit` and `jsonExitCode` in the text line). Merging
   #375 first, or soon after, closes this.

3. **The 129/130/143 map now has five copies.** They are `SIGNAL_EXIT` in prediction-runner.ts,
   `SIGNAL_EXITS` in agent-runtime.ts, `INTERRUPT_EXIT_CODES` in output-claims.ts, `SIGNAL_EXIT` in
   media-quality-commands.ts and, after the merge, `SIGNAL_BY_EXIT` in error-classify.ts. `exitOnInterrupt`
   also repeats the shape of media's `cancellable`. After #375 merges, the gate in `finalizeRun` could be
   `info?.code === "CANCELLED"` rather than a second set. Not blocking; a follow-up can move a shared map
   into src/core.

4. **SIGHUP is handled during the wait but not during the download.** output-claims registers only
   SIGINT/SIGTERM. If the terminal closes mid-download, Node's default action applies: no envelope,
   no history entry, and the `.part` lock stays behind until a later run takes it over as stale. This is
   pre-existing and outside #378. Open a follow-up issue rather than widening this PR.

5. **Gaps outside the issue's scope (follow-up issues, not this PR).**
   - A signal during the submit POST or during `--ref`/`--audio` uploads has no listener. The process
     dies silently, and if Atlas accepted the POST, a billed prediction exists with no id reported.
   - `multix atlas status <id> --wait` (the resume command itself) has no handler. A Ctrl-C there also
     ends with no envelope. No billing risk, since rerunning status is safe.

6. **Test hygiene.**
   - The unit test mutates the module-level `run` (`inFlight`, `ids`) and never resets it. No later test
     asserts on it today, but a future one would inherit `inFlight`.
   - It checks the listener count only for SIGINT, not SIGTERM/SIGHUP.
   - It relies on `process.listeners("SIGINT").at(-1)` being the new handler. The test comment documents
     this, and the smoke test covers real signals.
   - The smoke test treats any non-POST request as "polling started". If a GET is ever added before
     submit, the test fails loudly (default kill gives no exit code 130) rather than passing falsely,
     so it is not a flake risk.

## Checked and fine
- Listener leaks: `process.off` runs in `finally` on success, on a thrown error and on timeout. Counts are
  restored (the unit test asserts it for SIGINT).
- Interaction with output-claims once-listeners: in a CLI run the wait always finishes before the first
  claim, so the two never overlap. If they did, either handler exits through the wrapped `process.exit`,
  and `finalizeRun` is idempotent (`run.finalized`).
- Double signal: `finalizeRun` is synchronous and `realExit` ends the process; a second signal cannot
  run first.
- No interaction with stdin-file's re-raising once-listeners: atlas paths do not use stdin-file.
- `provider_ids`: `trackInFlight` dedupes; telemetry has normally pushed the id already, so `unshift` is
  usually a no-op.
- `next[0]` is the resume command. `next.unshift` for budget/not-sent cases cannot apply to a signal
  exit after submit.
- Docs (README, SKILL.md, docs-site en/vi) match the behaviour, including stdout/stderr placement and
  exit codes. The Vietnamese text is equivalent to the English. After the merge, #375's for-ai-agents.md
  row ("If a provider request was already sent, the hint says so instead") stays compatible.
- No secrets or prompt text in the new stderr line (only the prediction id and the `--output` path the
  user gave).

## Metrics
- Lint issues: 0. Type errors: 0.
- New tests: 1 unit (mocked poll + signal path), 3 smoke (real SIGINT/SIGTERM against dist/cli.js, JSON
  and text). They check the exit code, `provider_ids`, `next[0]`, the hint and a single POST.

## Plan / task follow-up
Issue #378 acceptance criteria met: polling stops, 130/143 via `finalizeRun`, id in `provider_ids`,
`resumeCommand(id, opts.output)` in `next[]` (first), hint does not say "nothing was left behind" or
suggest a rerun, tests cover the signal path with no second submit. Composes cleanly with #375.

## Verdict
APPROVE. No blocking findings. Optional before merge: Low 1 (wording that is true in both phases).
Open follow-up issues for Low 4 and 5.

## Unresolved questions
- Should the download-phase interrupt keep the inFlight hint (current) or get its own "finished, outputs
  not saved" wording? This is a product wording choice; the action (resume) is right either way.
