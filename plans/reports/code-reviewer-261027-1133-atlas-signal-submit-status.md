# Code review: atlas signals during submit, uploads and status --wait (#388), commit b06f3cc

Branch `claude/gracious-heisenberg-ulpwxj`, base `origin/dev`. Reviewer did not write the code.

## Scope
- Files: src/agent/run-state.ts, src/agent/agent-runtime.ts (finalizeRun),
  src/providers/atlascloud/commands/{prediction-runner,generation-command,status,output-claims}.ts,
  tests/smoke/agent-mode.test.ts, tests/unit/providers/atlascloud/prediction-runner.test.ts,
  README.md, skill/SKILL.md, docs-site atlascloud.md (en + vi). 12 files, +230/-35.
- Read for context: error-classify.ts (classifySignalExit, CANCELLED hint, RETRYABLE set),
  result-envelope.ts (nextForError), cost-preflight.ts / cost-receipt.ts (provider_ids -> operation_id),
  env.ts (resolveMediaRefs), run.ts, audio.ts, speech-adapters.ts (atlas route uses runGenerationCommand),
  stdin-file.ts and media-quality-commands.ts (other signal listeners), docs-site reference/for-ai-agents.md (en + vi).

## Verification run
- `npm run lint`: clean (597 files). `npm run typecheck`: clean. `npm run build`: OK.
- `npx vitest run tests/unit/providers/atlascloud/prediction-runner.test.ts tests/smoke/agent-mode.test.ts`:
  58 passed, 1 skipped (pre-existing case-insensitive-FS skip).
- Manual text-mode run against dist/cli.js with a fake Atlas server that never answers the submit POST,
  SIGINT after 2 s: exit 130, stderr `Cancelled while submitting to ...; Atlas Cloud may already have
  accepted the prediction.`, then `code: CANCELLED (exit 130 with --json)` and the submit-in-flight hint.
  Server and CLI processes were stopped afterwards.
- worker/ imports nothing from atlascloud/commands or agent/run-state, so `check:mcp` is not needed.

## Overall assessment
Correct for the three goals. The new `exitOnInterrupt` wrappers sit back to back with no `await`
between them (upload -> buildModelInput -> executePrediction -> submit -> trackInFlight -> wait), so
no window is left where a signal falls to Node's default kill once uploads have started. Listeners are
removed in `finally`; the existing unit test that checks listener counts after `executePrediction`
now also covers the submit wrapper. The `finalizeRun` override is ordered correctly: `inFlight`
(resume) wins, `run.interrupted` applies only for a signal exit with no thrown error, and
`run.interrupted` can only be set by the handler that immediately exits, so a non-signal failure
cannot pick it up. Output-claims now registers SIGHUP like SIGINT/SIGTERM (exit 129). Its `once`
listeners are registered only in the delivery phase, after every wrapped phase has finished, so
they do not overlap the new handlers today. Callers covered: atlas image/video/audio/3d and the `speech`
atlas route (runGenerationCommand), plus `atlas run` (executePrediction).

No critical or high issues. One medium contract inconsistency (`retryable: true` on a cancel) and
some low doc and test gaps.

## Critical
None.

## High
None.

## Medium

### M1. Upload-phase cancel reports `retryable: true`, unlike every other CANCELLED
`src/providers/atlascloud/commands/prediction-runner.ts:227-230` (`NOTHING_SUBMITTED`), documented in
`skill/SKILL.md:185` ("`retryable: true`").
- Elsewhere `retryable` means a transient failure that is safe to retry automatically: the RETRYABLE set
  in `src/core/error-classify.ts:127` is RATE_LIMITED, PROVIDER_UNAVAILABLE, NETWORK_ERROR and TIMEOUT.
  The generic clean cancel (`HINTS.CANCELLED`, "nothing was left behind. Rerun the command.") is `retryable: false`.
- Scenario: a user or supervisor sends SIGTERM to `multix atlas image-to-image --ref big.mp4 ... --json`
  to stop it on purpose. An agent loop that auto-retries on `error.retryable === true` (which is what the
  field invites) starts the job again, and this time the prediction is submitted and billed. The same
  cancel during a non-Atlas command, or during an Atlas run with no refs, is not retried.
- Fix: use `retryable: false` in `NOTHING_SUBMITTED` (keep the "Rerun the command" hint, which already says
  a rerun is safe). Update SKILL.md and the smoke assertion
  (`tests/smoke/agent-mode.test.ts`, `retryable: true` in the upload case). If `true` is a deliberate new
  meaning ("safe to rerun"), document it in reference/for-ai-agents.md (en + vi) so that it is a contract
  rather than a one-off.

## Low

### L1. The reference exit-code table still describes only the old CANCELLED hints
`docs-site/src/content/docs/reference/for-ai-agents.md:112` and `docs-site/src/content/docs/vi/reference/for-ai-agents.md:112`.
- The table says that if a provider request was sent, the hint says to "fetch the result by `provider_ids` before
  rerunning". After this change an Atlas submit-phase cancel has no `provider_ids` and points to the console, an
  upload-phase cancel sent requests but is reported as clean, and a stopped wait puts the resume command in `next[0]`.
  An agent that reads only the reference page gets the old rule.
- Fix: add one sentence (en + vi) saying that some commands give a phase-specific hint (a resume command first in
  `next`, or "check the provider console") and that the envelope's `hint` is authoritative.

### L2. The `status --wait` resume command adds `--download` and drops the user's flags
`src/providers/atlascloud/commands/status.ts:49-50` with `resumeCommand` (`prediction-runner.ts:181`).
- Scenario: `multix atlas status p1 --wait --json` (observe only, no download) is stopped by SIGINT.
  `next[0]` is `multix atlas status p1 --wait --download`, so an agent that follows it downloads media into
  `MULTIX_OUTPUT_DIR`, which the original command did not ask for. `--image-format`, `--no-webp`, `--no-thumb` and
  `--wait-timeout` are also dropped. The in-flight hint (`agent-runtime.ts`, "Job p1 was submitted before the run
  stopped ... Do not rerun") also reads oddly for a status lookup: rerunning `status` costs nothing.
- This matches the timeout `resumeHint` that existed before, and the issue asks for "the resume command", so
  this is not a regression. Fix if wanted: in status, build the resume from its own flags (keep `--wait` and
  add `--download` only when the user gave it). Otherwise accept and leave as is.

### L3. A signal during the schema fetch still dies without an envelope or history
`src/providers/atlascloud/commands/generation-command.ts:43` and `run.ts` (`loadModelSpec`, a GET before uploads or submit).
- No listener is installed there, so SIGINT uses Node's default: the process dies from the signal, with no
  `finalizeRun`, no JSON envelope and no history row. This was the case before the change and is outside #388's
  three goals, but it is the only remaining unwrapped network phase in the Atlas generation path.
- Fix: open a follow-up issue. A fix could wrap `loadModelSpec` in `exitOnInterrupt` with `NOTHING_SUBMITTED`
  (or `HINTS.CANCELLED`).

### L4. Docs name only `--ref`, but `--audio` uploads take the same path
README.md (atlas bullets), docs-site atlascloud.md (en + vi), skill/SKILL.md.
- `atlas audio --audio ./clip.mp3` goes through `cfg.refs`, so a signal during that upload is also a clean cancel,
  and stderr says "Cancelled while uploading references". The docs say "`--ref` files".
- Fix: write "local `--ref` / `--audio` files", as the README's previous bullet already does.

### L5. Test gaps
- No unit test for the `finalizeRun` precedence added at `src/agent/agent-runtime.ts:243-249`: `inFlight` must win
  over `interrupted`, and `interrupted` must be ignored when `input.error` is set or the exit code is not
  129/130/143. The smoke tests cover each path only end to end.
- No unit test drives the submit-phase handler with an injected `exit`, to check that `run.interrupted` is set,
  that the stderr message is printed and that the listeners are removed when the POST rejects. The
  listener-count check in the existing wait test covers only a submit that succeeds.
- The smoke tests send SIGINT during submit and SIGTERM during upload. That is enough, since the mapping table
  is shared.
- Fix: add two or three small unit cases (call `finalizeRun` with a synthetic `run` state; call `exitOnInterrupt`
  with a rejecting `work` and an exit that throws), and reset `run.interrupted` afterwards.

### L6. A latent ordering hazard between the two signal mechanisms (informational)
`output-claims.ts:220-228` (`process.once`, never removed) vs `prediction-runner.ts:213-218` (`process.on`).
- Node calls listeners in registration order. If a future change claims an output path before a wrapped phase
  (for example, pre-claiming `--output` before submit), `handleInterrupt` runs first and exits before `stop` sets
  `run.interrupted`, so the envelope silently falls back to the generic provider-contacted hint. This cannot
  happen today.
- Fix (optional): have `stop` record `run.interrupted` and the message before any exit path, for example by
  having `handleInterrupt` defer to a shared signal registry. Or add a comment in output-claims stating the
  invariant that claims are taken only after submit.

### L7. Nit: the Vietnamese paragraph is not rewrapped
`docs-site/src/content/docs/vi/commands/atlascloud.md`: one line runs past the paragraph's wrap width
("...chưa có gì được submit. Prediction kết thúc ở trạng thái `failed` làm lệnh thoát"). Cosmetic only.

## Edge cases checked (no issue)
- Signal while the submit response arrives: `finally` runs only after `await work()` resumes, so a signal there
  still reports "may have been accepted". That is conservative and correct.
- `--async`: returns after the submit wrapper with no `trackInFlight`, so behaviour is unchanged.
- `stdin-file.ts` re-raise handlers: not used by any Atlas or speech-atlas path.
- `provider_ids` from `trackInFlight` in status: the id was already added by fetch telemetry after the first poll,
  so operation_id (`atlas:<id>`) does not change. Only a signal before the first poll response gains the id, which
  is what the issue asks for.
- Envelope `next` for CANCELLED is `[]` (nextForError default), so the submit-phase envelope never suggests a rerun.

## Plan / issue follow-up
- Goal 1 (submit vs upload): met. M1 should be decided before merge.
- Goal 2 (`status --wait`: 128+n, resume first in `next`, id in `provider_ids`): met, see L2.
- Goal 3 (SIGHUP in output-claims, exit 129): met and unit-tested.

## Unresolved questions
- Is `retryable: true` on the upload cancel intended as a new meaning ("safe to rerun") or an accident? See M1.
- Does Atlas bill or keep `uploadMedia` files? The hint says "no prediction was created or billed", which is true
  for predictions. Uploaded files may stay hosted.
