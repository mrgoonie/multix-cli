# Code review: Atlas Cloud signal phases (#388), commit 3517eaa

Scope: `git diff origin/dev...HEAD -- src tests README.md skill docs-site/src` (13 files, +205/-41).
Verification run locally (Node 22.22): `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok,
`npm test` 2270 passed / 22 skipped, the 3 new smoke tests passed 3 out of 3 isolated reruns, `npm run verify:docs` 8/8.

## Verdict

Nothing blocks merging. The four phases in the issue behave as described for the paths they wrap.
- Schema load and uploads: `beforeSubmit` sets `preSubmit`, and `finalizeRun` passes `providerContacted=false`, so the hint is "nothing was left behind".
- Submit POST: `preSubmit=false`, the hint says a paid job may already exist, and `inFlight` is unset.
- `status --wait`: `trackInFlight` runs before the wait, so the inFlight override gives `retryable:false` and puts the resume command at `next[0]`.
- Download: SIGHUP is now in `INTERRUPT_EXIT_CODES`.

Listeners do not stack. Each `exitOnInterrupt` removes its own listener in `finally`, and the phases run one after another.
An error thrown while `preSubmit` is still true goes through `classifyError` and never reads the flag, so leaving it true does no harm.
`run --async` is covered: the submit is wrapped, and the run returns before `trackInFlight`.
EN and VI docs agree with each other and with the code.

The findings below are gaps that remain, not regressions.

## Medium

### M1. Download phase has no signal handler until the first response headers arrive
Locations:
- `src/providers/atlascloud/commands/output-claims.ts:162` (handler installed lazily in `tryLock`)
- `src/providers/atlascloud/commands/output-claims.ts:281-298` (claim taken inside the `dest(response)` callback)
- `src/providers/atlascloud/commands/prediction-runner.ts:394`

The wait handler is removed when `waitForPrediction` resolves (`prediction-runner.ts:218`). The claim handlers are installed only in `tryLock`, which runs after `downloadToFile` gets response headers. Between those two points there are no SIGINT/SIGTERM/SIGHUP listeners, which covers DNS, TLS and time-to-first-byte of the first output. Node's default action then kills the process.

The same gap applies to:
- `status <id> --download` when the prediction is already completed;
- a submit that returns a terminal status (`isTerminalStatus(submitted.status)` skips the wait wrapper);
- runs where every output is "already saved", where no claim is ever taken.

Failure scenario: `multix atlas video ... --json`. The prediction completes, and the user presses Ctrl-C while the CDN is slow to answer. The process dies by signal with no envelope, so there is no `provider_ids` and no `next[0]` resume command. An agent sees no JSON and may resubmit, paying twice. The issue's goal ("report signals correctly in every phase") is not met for this window. The gap existed before this change.

Suggested fix: wrap `deliverPrediction` in `executePrediction` and `status.ts` in a handler that cleans up claims and then exits:

```ts
exitOnInterrupt(() => deliverPrediction(...), waitCancelledMessage(id, resume), o.exit)
```

Make the `stop` callback in `exitOnInterrupt` call `cleanupActiveClaims()` before `exit`. Alternatively, install `installInterruptCleanup()` eagerly at the start of `deliverPrediction`.

If this is out of scope for #388, open a follow-up issue as AGENTS.md requires.

### M2. New behaviour is covered only partly by tests
None of these paths has a test:
- `preSubmit` in `finalizeRun` (no unit test in `tests/unit/agent`);
- a signal during an upload (`resolveMediaRefs` inside `beforeSubmit`, which is the main reason the flag exists, since uploads are POSTs that increment `requestsStarted`);
- `atlas run` going through `beforeSubmit`;
- SIGHUP while `status --wait` polls, expecting exit 129.

The SIGHUP unit assertion at `tests/unit/providers/atlascloud/prediction-runner.test.ts:677` (`listenerCount("SIGHUP") > 0`) is weak. It passes whenever any SIGHUP listener exists in the vitest worker. It does not show that the claim module installed one.

Suggested fix:
- Add a smoke case: `atlas image "a cat" --ref ./x.png --no-validate`, with the fake server leaving `POST /upload...` hanging, then SIGINT. Expect exit 130, the "nothing was left behind" hint, and no generate POST.
- Add a unit test of `finalizeRun` with `preSubmit` true and `requestsStarted > 0`.
- Compare the SIGHUP listener count before and after the first claim, or check that the listener calls `handleInterrupt`.

## Low

### L1. Signal can be lost or default-killed between phases
`prediction-runner.ts:218` / `:243` / `:262`, and `generation-command.ts` around the `beforeSubmit` -> `executePrediction` hand-off.

Each phase removes its listeners and the next phase adds new ones. While no listener exists, Node/libuv restores SIG_DFL. A signal that is queued in the same loop turn in which the previous phase's promise settles goes to a signal handle that is already closed, so it is dropped. The window is only a few microtasks, so this is theoretical.

Suggested fix: install one command-scoped handler and only change its message and cleanup per phase (for example a mutable `phase` object). This also fixes M1.

### L2. `beforeSubmit` cannot take the injectable `exit`
`prediction-runner.ts:226`. `executePrediction` accepts `o.exit` for tests, but `beforeSubmit` always uses `process.exit`. As a result the pre-submit phase can only be tested by spawning a process. Add an optional `exit` parameter.

### L3. "Nothing was left behind" is not strictly true after a partial upload
Locations: `src/core/error-classify.ts:98` and the `skill/SKILL.md` sentence.

A signal after the first of several `--ref` uploads leaves that file hosted on Atlas Cloud storage. Nothing is billed, so the "safe to rerun" advice holds. The wording in the docs is accurate ("no prediction was created"). Only the generic CANCELLED hint, which SKILL.md now quotes, overstates it. This is informational: either keep it, or reword the SKILL line to "no prediction was created".

### L4. `status` without `--wait` and `atlas upload` still die on a signal with no envelope
`status.ts:59`. These were never in scope and are read-only or non-billing, so there is no billing risk. Noted only because the docs say "every phase" for status (they say "status --wait", which is accurate).

## Edge cases checked, no issue found
- `preSubmit` left true after an error in schema load, validation or upload: the error path uses `classifyError`, so the flag is unused.
- Errors from `assertEndpoint` / `validateRawInput` in `run.ts` between phases are synchronous, so no signal window opens there.
- `run --async` / `image --async`: the submit is wrapped and the hint is correct; the id goes to stdout and the run exits normally.
- In `status --wait`, the `preSubmit` value of `undefined` leads to the providerContacted hint, which the inFlight hint then overrides, giving `retryable:false` and the resume command at `next[0]`.
- `trackInFlight` in status puts the id in `provider_ids` even for non-signal failures (for example a 404 on an unknown id). This is harmless and matches what the generation commands do.
- Download listeners (`process.once`) and the wait listeners never coexist in one run.
- Smoke-test determinism: each child installs its handler before the first request reaches the fake server, so `await seen.first` followed by `kill` cannot race.
- Docs: README, SKILL.md and docs-site EN/VI make the same claims, and those claims match the code.

## Unresolved questions
- Is M1 (download before the first headers) meant to be covered by #388's "every phase", or should it be a follow-up issue?

## Resolution (implementer)

- **M1: fixed.** `deliverPrediction` now runs inside `exitOnInterrupt` in both `executePrediction` and `status`. The stop handler calls `cleanupActiveClaims()` before it exits, so a signal before the first output claims its path still prints the resume command and exits 128 + the signal number. Covered by the unit test "a signal before the first output responds…", which fails without the fix.
- **M2: fixed.** Added smoke tests for SIGTERM during a `--ref` upload, SIGINT while `atlas run` loads the schema, and SIGHUP during `status --wait` (exit 129). Removed the weak `listenerCount("SIGHUP")` assertion.
- **L1: no change.** Between phases only synchronous code and microtasks run. Node dispatches signal listeners from the event loop, so no signal can land in that gap.
- **L2: no change.** The pre-submit phase is covered end to end by smoke tests.
- **L3 and L4: no change.** Both are out of scope and nothing is billed in either case. Uploaded media is not a paid job, so a rerun is still safe.
