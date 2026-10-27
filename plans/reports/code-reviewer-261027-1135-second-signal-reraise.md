# Code review: second-signal re-raise in `cancellable()` (#385)

Scope: `git diff -- src tests` against origin/dev @ 1ba0b4a
- src/commands/media/media-quality-commands.ts (+8/-3)
- tests/smoke/media-quality.test.ts (+37)

Status: DONE_WITH_CONCERNS
Summary: On Linux the fix works. A second signal kills the process with that signal, and execa's signal-exit listener (registered before or after `stop`) does not stop the kill. The first-signal path is unchanged. Lint and typecheck pass. The new smoke test passed 5 of 5 runs and cannot fail falsely except in one narrow window. Concerns: the re-raise does nothing when node runs as PID 1. On Windows a SIGHUP throws ENOSYS and a SIGINT now exits with 1. The docs that map exit 130 to "nothing left behind" are now incomplete.

## How it was checked
- Read signal-exit 4.1.0 (`node_modules/signal-exit/dist/mjs/index.js`) and execa `lib/terminate/cleanup.js`. execa's onExit callback returns undefined, so signal-exit re-raises the signal itself when it is the only listener left.
- Scratch harness (removed), Linux, Node 22.22: `stop` plus a live `execa("sleep")`, in both registration orders. A double SIGINT gave status 130 by signal both times, and no `sleep` child was left behind.
- Scratch harness against dist/cli.js, 20 runs per case. The old code came from a patched copy of dist.
  - New code, 2 ms gap: 11 runs died by SIGINT with empty stdout, 9 printed CANCELLED with nothing staged.
  - Old code, 2 ms gap: 14 of 20 printed CANCELLED with a `.frames-*` dir left behind (the bug), so the test catches it.
  - New code, 0 ms gap: 19 died by the signal. Old code, 0 ms gap: 19 left the dir behind. I did not see two signals merge into one outside vitest.
- `vitest run tests/smoke/media-quality.test.ts -t "second Ctrl-C"` passed 5 of 5. `biome check` on both files is clean. `npm run typecheck` is clean.
- Checked for other signal listeners in this path. `src/core/stdin-file.ts` (once-listeners that re-raise the same way) and `atlascloud/output-claims.ts` are not used by `media inspect/verify/frames`. Nothing else registers SIGINT, SIGTERM or SIGHUP listeners.
- PID 1 check: `unshare -fp` with the same handler pattern. The re-raise did nothing, a third SIGINT was ignored too, and the process exited 130 only after its cleanup timer ran.
- No processes left running. Scratchpad emptied.

## Critical
None.

## High
None.

## Medium
1. src/commands/media/media-quality-commands.ts:67-71: when node is PID 1 the second signal does nothing, and so do all later ones. This affects `docker run <img> multix media frames ...` without `--init`, and any container where the CLI is the entrypoint. The kernel drops a default-action signal that PID 1 sends to itself. Because `stop` has also removed its listeners, every later SIGINT, SIGTERM or SIGHUP is dropped as well. Before this change, process.exit forced the exit. Now the user cannot interrupt the run until cleanup finishes or something sends SIGKILL from outside (for example `docker stop` after its grace period). The outcome is still honest: cleanup runs and then CANCELLED is printed. The repo's own job container is not affected, because `job-server.mjs` is PID 1 and the CLI runs as its child.
   Fix: after `process.kill`, add a fallback that exits without an envelope. For example `setImmediate(() => exitWithoutEnvelope(SIGNAL_EXIT[signal] ?? 1))`, using a small export from agent-runtime that calls `realExit` and skips `finalizeRun`. On POSIX, when the process is not PID 1, it dies before the fallback runs. On Windows the process is terminated synchronously.
2. docs-site/src/content/docs/reference/for-ai-agents.md:112, docs-site/src/content/docs/vi/reference/for-ai-agents.md:112, README.md:87, skill/SKILL.md:22: these say "129/130/143 = CANCELLED, cleaned up, nothing was left behind". After the fix, a second signal kills the process, and a shell or agent wrapper still sees status 130 (128+2), but with no envelope and with the staging dir possibly still on disk. Suggest one sentence in the for-ai-agents exit-code table (EN and VI) and in SKILL.md: "130/143/129 without a JSON envelope means a second signal killed the run before cleanup; temp or `.frames-*` staging directories may remain." README.md:901 and docs-site/src/content/docs/commands/media-and-documents.md:144 (EN) and vi/commands/media-and-documents.md:141 (VI) describe only the first signal. That is still accurate; adding "a second Ctrl-C stops at once and skips the cleanup" there is optional.

## Low
3. src/commands/media/media-quality-commands.ts:69: on Windows, `process.kill(process.pid, "SIGHUP")` throws ENOSYS. libuv supports only SIGINT, SIGTERM, SIGKILL and SIGQUIT there, and signal-exit maps SIGHUP to SIGINT on win32 for exactly this reason. A second SIGHUP, or a console close after a Ctrl-C, would end as an uncaught exception: exit 1 with a stack trace and no envelope. It is unlikely in practice and harmless in effect, but it is not deliberate. Fix: `process.kill(process.pid, process.platform === "win32" && signal === "SIGHUP" ? "SIGINT" : signal)`. `src/core/stdin-file.ts:173` has the same latent issue and was there before this change.
4. Windows exit status: a second Ctrl-C used to give exit 130 with a (false) CANCELLED envelope. Now `process.kill(pid, "SIGINT")` calls TerminateProcess with code 1, so the exit is 1 with no envelope. The correctness gets better (no false claim), but the 128+n status is lost on Windows. Acceptable, and the fallback in Medium 1 would not change it. Mention it in the PR so nobody expects 130 on Windows.
5. tests/smoke/media-quality.test.ts:249-251: a narrow false-failure window remains. The `finally` block (line 81) removes the listeners before `process.exit` (line 86). It calls the patched exit, which writes the envelope through finalizeRun. A second SIGINT that lands between the envelope write and the real exit kills the process by the signal with stdout not empty, and the test's `signal` branch fails, even though the run was honest. The window is microseconds, so the flake risk is very small. A tighter invariant would be: if stdout has a CANCELLED envelope, then `staged()` is empty; if `res.signal !== "SIGINT"`, then the exit code is 130.
6. tests/smoke/media-quality.test.ts:246: the comment says two back-to-back kills merge into one. Outside vitest, 19 of 20 runs with a 0 ms gap delivered both signals. The 2 ms wait is harmless, but the comment states as a general fact what the author saw under one load. Suggest "can merge into one".

## Informational (not regressions)
- With a second signal, detached `--rule` process groups (media-rule.ts:114-118, `detached: posix`, so execa's cleanup is skipped) are not killed if the first signal's abort has not reached them yet. The old process.exit path had the same issue. A candidate for a separate issue.
- The first-signal path is the same apart from the hoisted `signals` const.
- The mechanism matches the existing precedent in `src/core/stdin-file.ts:171-175`. No parallel reimplementation and no scope drift.

## Edge cases checked
- signal-exit registered after `stop` (usual case): signal-exit's listener runs in the same emit, sees itself as the only listener, unloads and re-raises. The process dies within that emit.
- signal-exit registered before `stop`: the first re-raise is caught by signal-exit's handler and delivered on the next loop turn, then signal-exit re-raises. Death comes one tick later. Verified.
- Different second signal (SIGINT then SIGTERM): the process dies by the second signal. Fine.
- A signal after `finally`: the default action applies. Same as before.

## Metrics
- Lint: 0 issues (biome, 2 files). Typecheck: clean.
- New test: 5 of 5 passes. In a scratch harness it catches the old bug in about 70% of runs, and never fails falsely apart from Low 5.

## Unresolved questions
- Is containerized use with the CLI as PID 1 a supported scenario? That decides whether Medium 1 must block the merge.
