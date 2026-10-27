# Code review: Atlas signal handling during uploads, submit, `status --wait` and downloads (#388)

Isolated reviewer (separate subagent context) on commit d4d238e, base `dev` @ 0cbd52f.
Checks run by the reviewer: build, lint, typecheck, `tests/smoke/agent-mode.test.ts` and
`tests/unit/providers/atlascloud` (signal smoke tests 5 runs in a row, no flakes), plus a
loopback reproduction against `dist/cli.js` with an unanswered submit.

Verdict on d4d238e: request changes (H1, M1). All findings below are resolved in the
follow-up commit on the same branch.

## Findings and resolution

| # | Severity | Finding | Resolution |
|---|---|---|---|
| H1 | High | A signal during an unanswered submit gave `cost: settled, $0, "No provider request was sent"`, contradicting the paid-prediction hint: fetch telemetry recorded a call only once it was answered or threw. | `fetch-telemetry.ts` keeps unanswered requests; `finalizeRun` records them as status 0 (cut off), so the receipt is `uncertain`. Smoke test asserts `cost.status === "uncertain"`. |
| M1 | Medium | Downloads to a single-file `--output` (`overwrite` policy), and any download before its first lock, had no signal handler: Node's default kill, no envelope or resume command, temp `.part` left behind. The new docs claimed the guarantee. | `downloadClaimed` installs the cleanup handlers before connecting, whatever the policy; `overwrite` destinations are tracked so a signal removes this run's temp file. Unit test fails on the old code. |
| L1 | Low | Hint said the submit "reached" Atlas Cloud while the state is set before the request connects. | Reworded to "may have reached". |
| L2 | Low | Upload-phase cancel reused "nothing was left behind", while uploaded `--ref` files stay in Atlas storage. | Hint for a signal before the submit: "stopped before it submitted its paid job, so nothing was billed". |
| L3 | Low | Unit tests reset module-level `run` state at the end of the test body, leaking it when an assertion fails. | Reset moved to `afterEach`. |
| L4 | Low | `status --wait` resume command always adds `--download`. | Kept: same `resumeCommand` as the timeout hint and the generation commands. |

## Checked and found correct

- `run.submit` is cleared on `--async` and by `trackInFlight`; thrown errors bypass it (the signal path needs `error === undefined`); commands that never call `trackSubmit` keep the old behaviour.
- No listener leak: `exitOnInterrupt` removes its handlers in `finally`; it and the download handlers are never active together.
- Signals go through the patched `process.exit` and `finalizeRun`; text mode keeps 129/130/143.
