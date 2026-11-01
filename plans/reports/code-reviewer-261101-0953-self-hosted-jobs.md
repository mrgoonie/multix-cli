# Code review: self-hosted job execution (9b0a2d5..c40127b)

Branch `claude/relaxed-clarke-yce0xf`, commits aa09f20 (feat) and c40127b (docs).
Reviewed 2026-11-01 (UTC). HEAD has since moved to 85c0903 (docs only); that commit is not in scope.

## Scope

- Files: worker/server/{local-jobs.ts, standalone-app.ts, multix-server.ts, server-config.ts, Dockerfile, compose.yaml, server.env.example}, worker/src/jobs/account-job-quota.ts, worker/tsconfig.server.json, worker/server/test/{standalone-jobs.test.ts, fixtures/hold-multix.mjs, standalone-server.test.ts}, docs-site self-hosted-server.md (en + vi), llms.txt.ts
- About 915 lines added and 62 removed
- I also read the code these files depend on: container/local-executor.mjs, container/job-runner.mjs, container/job-outputs.mjs, src/jobs/job-runner.ts, job-store.ts, job-context.ts, server/durable-object-host.ts, server/http-server.ts, server/public-fetch-guard.ts

## Verification run

- `npx vitest run server/test/standalone-jobs.test.ts`: 8/8 pass
- `npx vitest run server/test test/local-executor.test.ts`: 49/49 pass
- `npm run typecheck` (worker, including tsconfig.server.json): clean
- `npx biome check worker/server`: clean

## Overall assessment

The core is sound:
- **Server-wide cap.** The executor's synchronous `running.size` check is the hard limit. The quota total is lowered to match it. I found no way past the server-wide cap.
- **Final state recorded once.** `finish()` runs per job id, one call at a time, and checks for a terminal state first. `notifyFinal` therefore fires once per job.
- **Releases are safe to repeat.** Slots are released through Durable Object turns, which `Gate` serializes. A second release at start-up (sweep plus reconcile) does no harm.
- **Keys stay out of storage.** Keys never reach a job file or KV.

The real defects are in shutdown ordering and in what the start-up reconciliation leaves behind. The tests cover the happy paths but miss these cases.

## Critical issues

None.

## High priority

None.

## Medium priority

### M1. On SIGTERM the job executor is starved by `http.close`, so `jobs.close()` is never awaited before `database.close()`

- Where:
  - worker/server/multix-server.ts:101-105 (`await http.close(config.shutdownTimeoutMs)`, then `app.stop(remaining)`, then `database.close()`, then `process.exit(0)`)
  - worker/server/standalone-app.ts:148-163 (`jobs.close()` is raced against a deadline of `timeoutMs`)
- Evidence:
  - `http.close` (http-server.ts:71-80) waits up to the whole budget while `inFlight > 0`.
  - `multix_run` and `POST /api/v1/jobs` poll for `wait_seconds`. The default is `DEFAULT_WAIT_SECONDS = 25` (src/jobs/job-runner.ts:30), the maximum is 40, and the default `MULTIX_SHUTDOWN_TIMEOUT_MS` is 20 s.
  - So one ordinary `multix_run` that is waiting on a running job when SIGTERM arrives uses up the full budget.
  - `app.stop(0)` then races `jobs.close()` against `setTimeout(0)`. `jobs.close()` has to do file I/O (awaiting inflight, `finishWithRetry` writes), so the deadline wins.
  - `host.stop(0)`, `database.close()` and `process.exit(0)` follow at once.
- Failure scenario: a rolling update while one job runs and its caller is polling. Three things go wrong:
  1. The executor never writes the "interrupted" final view during shutdown, and never aborts the CLI.
  2. Any `onFinal` that does start calls `quota.release` on a closed database and logs `job_slot_release_failed`.
  3. The CLI child dies only because the container's PID namespace is torn down. Outside a container (for example `kill <pid>` on a bare `node multix-server.mjs`), the CLI keeps running a billed provider call as an orphan. The next start marks the job interrupted and frees its slot, so a second job can run alongside the orphan.
- Docs conflict: the docs ("On SIGTERM running jobs are stopped and recorded as failed ... their slots are freed") and the multix-server.ts header promise behavior that does not hold in this common case. It is recovered only at the next start.
- Suggested fix:
  - Start `app.jobs?.close()` when shutdown begins, in parallel with `http.close`, not after it. Polling requests then see the terminal "interrupted" view and return early, which also shortens `http.close`.
  - Await that promise unconditionally before `database.close()`, with its own bound (`closeTimeoutMs` plus a small margin), not the leftover of the HTTP budget.
  - Alternatively, give `stop()` a separate job budget.
  - Add a test: a `multix_run` with `wait_seconds: 25` is open, then `stop` runs with a small timeout. Assert the job file says `interrupted` before the database closes.

## Low priority

### L1. Start-up reconciliation frees the server slot of an unrecorded job, but not its account slot

- Where: worker/server/local-jobs.ts:271-277 (the `else await server.release(jobId)` branch). Also any account slot whose server slot is already gone.
- Evidence:
  - `JobRunner.run` takes the account slot and then the server slot (`quota.acquire`) before the executor writes its record.
  - After a crash in that window, the job id is unknown to the executor. Reconcile releases only the server slot. The account slot stays until `JOB_SLOT_LEASE_MS`, which is 45 minutes (job-protocol.ts:77-85).
  - The same applies to an account-only slot: a crash between the account and server `acquire`, or a `finalHook` where the account `release` failed and the server `release` succeeded. Reconcile never looks at it, because it lists only `server:all`.
- Failure scenario: with `MULTIX_MAX_JOBS_PER_ACCOUNT=1`, that account gets `busy: you already have 1 running job` for up to 45 minutes after a restart, while it has no job.
- Why the test misses it: the test "after a crash, frees the slot ... of a job never recorded" (standalone-jobs.test.ts:908-919) passes only because the default per-account cap is 2.
- Suggested fix: nothing of this executor runs during reconcile, and the HTTP listener and alarms start later. Clear every `MULTIX_JOB_QUOTA` slot map (all `do_storage` rows with `ns = 'MULTIX_JOB_QUOTA'`, key `slots`), not only `server:all`. Or, for every held server slot, read the owner from the `job:<id>` record in ACCOUNTS_KV. Run the test with `MULTIX_MAX_JOBS_PER_ACCOUNT: "1"`.

### L2. Cancel gives the quota slots back before the CLI exits

- Where: container/local-executor.mjs `cancel()`. `finish()` calls `notifyFinal`, then `finalHook` calls `quota.release` (local-jobs.ts:239-245). The executor keeps `running` set until `slot.done` settles.
- Failure scenario A (`MAX_CONCURRENT>1`, `PER_ACCOUNT=1`):
  - Between `multix_job_cancel` and the CLI's exit, the account can start another job. The quota says it is free, and the executor still has room.
  - The user then has two CLI processes and two provider calls at once.
  - The window is usually milliseconds. It is longer when the CLI has ffmpeg or magick children holding its stdio pipes, because `execFile` resolves on `close`.
- Failure scenario B (`MAX_CONCURRENT=1`, the default):
  - The next job right after a cancel passes the quota, is refused by the executor, and gets "server at capacity" although the caller has nothing running.
  - The test hides this with `until(() => activeJobs() === 0)` (standalone-jobs.test.ts:843).
- Suggested fix: give the slots back when the CLI has exited, not on the canceled write. For example, `onFinal` for a canceled job waits on a promise for the end of the slot. Or the executor exposes a `slotFreed(jobId)` hook that `local-jobs.ts` uses to release.

### L3. The image lacks the ImageMagick JPEG/WebP coders and `cwebp`

- Where: worker/server/Dockerfile:45, `apk add --no-cache ffmpeg imagemagick ca-certificates`.
- Evidence (pkgs.alpinelinux.org, v3.22): `imagemagick` 7.1.2 provides `magick`, but the JPEG, WebP, HEIC, TIFF and SVG coders are separate subpackages (`imagemagick-jpeg`, `imagemagick-webp`, ...). They are neither dependencies nor install_if.
- Failure scenarios:
  - `media optimize` and `media batch` are allowed job commands (src/jobs/cli-command-policy.ts:513-515). They fail with "no decode delegate" on JPEG input or WebP output.
  - The CLI's default WebP finalization calls `cwebp` (src/core/image-webp-finalize.ts:110). It is not installed (`libwebp-tools`), so every generated image falls back to the original format with a warning.
- The job image (worker/container/Dockerfile) has the same gap, so this is parity, not a regression. Still, the new header comment claims the image provides what the CLI needs.
- Suggested fix: `apk add imagemagick-jpeg imagemagick-webp libwebp-tools` in both images. Optionally add `imagemagick-heic` and `imagemagick-tiff`.

### L4. Node is PID 1 with no init, and the server now spawns process trees

- Where: worker/server/Dockerfile (exec-form `CMD ["node", ...]`); compose.yaml has no `init: true`.
- Evidence: before this change the server spawned nothing. Now each job runs the CLI, which spawns ffmpeg or magick through execa.
- Failure scenario:
  - When a job is canceled or times out, `execFile` sends SIGTERM to the CLI only.
  - Grandchildren that outlive it are reparented to PID 1. Node (libuv) reaps only the PIDs it spawned.
  - Zombies build up over the life of the pod.
- Suggested fix: `init: true` in compose, plus `--init` and the Kubernetes note in the docs. Or `apk add tini` with `ENTRYPOINT ["/sbin/tini","--"]`. tini forwards SIGTERM, so graceful shutdown still works.

### L5. Test gaps against the acceptance criteria

All in worker/server/test/standalone-jobs.test.ts.

- **"Not re-run" after a restart is not asserted** (lines 868-880). The test checks the `failed`/interrupted status but never checks that `runnerCalls` did not grow during `start()`. The executor's own suite covers this (test/local-executor.test.ts), but this end-to-end suite does not. Add `expect(runnerCalls).toHaveLength(3)` straight after `await start()`.
- **Account-slot leak is masked** by the default per-account cap of 2 (see L1).
- **Shutdown under an open poll is not tested** (see M1). `stop()` in the test uses `http.close(1000)` with no request in flight.
- **R2 credentials are not covered by the key-leak check.** No R2 settings are configured, so `spec.upload.r2.secretAccessKey`/`accessKeyId` never flow through redaction or persistence. Configure a fake R2 setting and inject an upload `fetch`, then assert neither value appears in `seen`, the job files or KV.
- **Executor refusal is not tested.** No test covers the path where the quota says ok but the executor is full (the L2 path). That is the only route by which a refused job writes a record and fires `onFinal` with a capacity error.

## Checked and found correct

- Quota caps:
  - `MULTIX_MAX_JOBS_TOTAL` is set to `min(jobCapsFrom(env).total, maxConcurrent)` after binding (standalone-app.ts:519-520). `jobCapsFrom` is read per request, so it takes effect.
  - An invalid operator value falls back to the default and is still clamped.
- Released exactly once:
  - `finish()` checks for a terminal state inside `serialized()`, so the run ending, cancel and shutdown produce one `notifyFinal`.
  - Repeat releases at start-up (sweep `onFinal` plus reconcile) are harmless no-ops, serialized by the host `Gate`.
- Reconcile safety:
  - It runs after the executor lock is taken and the recovery sweep, and before `host.resumeAlarms()` and the HTTP listener.
  - On the same host it cannot free the slot of a live job. A second process fails at `acquireLock` before it reaches reconcile.
  - Other nodes are out of scope, as documented.
- `onFinal` versus `close()`: `notifyFinal` runs on a microtask after the write, and `shutdown()` awaits every `fileLocks` chain. With the extra `setImmediate`, `finals` is complete when it is awaited. The only gap is M1, where `close()` itself is not awaited.
- Secrets:
  - The spec, with keys and R2 credentials, stays in memory.
  - Job files hold the owner and view only. stdout and stderr are redacted before truncation.
  - `logEvent` calls in local-jobs.ts log only job ids and error names.
  - The test checks job files, KV rows, responses and console output for the Gemini key.
- SSRF:
  - Input downloads use `publicHttpsGet` from job-network.mjs, with the check made on the address actually connected to.
  - Uploads go through `globalThis.fetch`. The guard in public-fetch-guard.ts:83-88 passes a public-only dispatcher on every call. The test's `setGlobalDispatcher(new Agent())` does not weaken it in production.
- Cloudflare path: account-job-quota.ts only exports `SLOTS_KEY`, with no behavior change. `LocalAccountJobQuota` lives in worker/server only.
- Dockerfile (other points):
  - `tsup.config.ts` is copied and not excluded by Dockerfile.dockerignore.
  - The lockfile has `@rollup/rollup-linux-x64-musl`. The esbuild Linux binaries are static.
  - dist/cli.js keeps its shebang (from src/cli.ts). The `package.json` beside it is copied.
  - The `/usr/local/bin/multix` symlink is created as root before `USER node`.
  - The read-only root file system works: the CLI's HOME and output directory are under the per-job `/tmp` directory, and the executor's state and socket are in node-owned `/data/jobs`.
  - The socket path `/data/jobs/executor.sock` is well under 107 bytes.

## Recommended actions

1. M1: start `jobs.close()` at the beginning of shutdown, await it before `database.close()` with its own bound, and add the shutdown-under-poll test.
2. L1: clear all quota slot maps at start-up, or look up owners in ACCOUNTS_KV. Run the crash test with a per-account cap of 1.
3. L2: give the quota slots back when the CLI has exited, not on the canceled write.
4. L4: add an init process (`init: true` in compose, or tini).
5. L3: add `imagemagick-jpeg imagemagick-webp libwebp-tools`, in both images. This can be its own issue, since the job image shares the gap.
6. L5: add the missing assertions (no re-run, R2 credentials redacted, executor refusal).

## Metrics

- Type coverage: typecheck clean (`allowJs` with `checkJs: false`, so the .mjs executor is untyped and cast via `as unknown as LocalExecutor`)
- Tests: 8 new end-to-end tests, all passing. Coverage percentage not measured.
- Lint issues: 0

## Plan follow-ups

No plan file was provided. The acceptance criteria stand as follows:
- **Second job refused before the provider is called:** met and tested.
- **Restart marks the job interrupted and frees its slot:** met for the server slot. The account slot is not freed for an unrecorded job (L1).
- **Job not re-run after a restart:** met in code, but not asserted in this suite.
- **No key leak:** met for provider keys. R2 credentials are untested.

## Unresolved questions

- Is a bare-metal (non-container) `multix-server` deployment supported? If so, M1's orphaned-CLI consequence rises in severity.

---

## Round 2: fix commit 0c8ebd4

Reviewed 2026-11-01 (UTC): `git show 0c8ebd4` on `claude/relaxed-clarke-yce0xf`.

### Verification run

- `npx vitest run server/test test/local-executor.test.ts`: 51/51 pass (5 files)
- `npm run typecheck` (worker, test and server configs): clean
- `npx biome check worker/server worker/container`: clean

### Status of round-1 findings

| Finding | Status | Evidence |
|---|---|---|
| M1 shutdown order | Fixed | server-shutdown.ts:20-26 drains, starts `closeJobs()` before `http.close`, and awaits it before `database.close()`. standalone-app.ts:129-151 bounds `closeJobs` by its own budget (`closeTimeoutMs` + 5 s), not the HTTP leftover. It never rejects and always returns the same promise. `stop()` awaits it (line 196) even when the drain used the whole budget. An open poll now sees the interrupted view and returns, so the drain is short. The new test proves this with a 25 s poll and a 30 s budget: the server stops in under 10 s, the poll gets the interrupted result, the CLI pid is gone and no release failure is logged. |
| L1 start-up slot clear | Fixed | local-jobs.ts:205-217 clears the slot map of every `MULTIX_JOB_QUOTA` object (`SELECT DISTINCT id FROM do_storage WHERE ns = 'MULTIX_JOB_QUOTA'`). It runs after the executor lock and the recovery sweep, before `host.resumeAlarms()` and before the listener opens (multix-server.ts creates the app before `listen`). See the safety notes below. |
| L2 slots released only when the CLI exits | Fixed | local-executor.mjs:317-323 defers `notifyFinal` behind `slot.done` while the job holds an executor slot. See the race analysis below. |
| L3 coders and cwebp | Fixed in both images | `imagemagick-jpeg imagemagick-webp libwebp-tools` are added. These packages exist in Alpine v3.22. |
| L4 init process | Fixed | `tini` is installed and `ENTRYPOINT ["/sbin/tini","--"]` is set. pkgs.alpinelinux.org confirms the `tini` package installs `/sbin/tini`. The CMD keeps exec form, so node gets the SIGTERM that tini forwards. Neither compose.yaml nor the Kubernetes manifest in the docs overrides `command`, so tini is not bypassed. |
| L5 test gaps | Closed | New tests cover: no re-run (`runnerCalls` unchanged after `start()`), a per-account cap of 1, an account-only slot, executor refusal releasing its slots, shutdown with a poll open, a canceled CLI keeping its slots (the fake CLI exits 600 ms after SIGTERM), and R2 credentials in the leak check, with an injected upload `fetch` that refuses anything other than a PUT to the fake bucket. |

### L2 race analysis (verified, no defect)

- **Normal completion.** `finish` runs inside the `slot.done` chain, so `slot.done.finally(notify)` fires after the chain's own `finally(() => running.delete)`. The executor slot is freed first, then the quota slots, through microtasks only, so no request can run in between. The order is the reverse of round 1, and the safe one: in the gap a new job is refused by the quota, which writes no record and makes no provider call.
- **Cancel, then completion.** The cancel's `finish` records `canceled` and defers its notice. The run's later `finish` sees a terminal state and returns, so exactly one notice is sent.
- **Cancel while the record is being written.** The record becomes visible after `link`, during `syncDir`, while `slot.done` is still undefined. That cancel notifies at once, which is correct: `startJob` then sees the abort, calls `running.delete` and never runs the CLI.
- **close() alongside a cancel or a running job.** `shutdown()` sees the job still in `running`. `finishWithRetry` either records `interrupted` or finds `canceled` already recorded; either way the notice is deferred once. It fires when `slot.done` settles. That happens before the executor's `allSettled(fileLocks)` and the socket close, and local-jobs adds a `setImmediate` before it awaits `finals`. So `finals` is complete for every CLI that exits within `closeTimeoutMs`.
- **Restart path.** The sweep runs with an empty `running` map, so interrupted jobs notify at once. The start-up clear then removes whatever is left, and releasing twice does no harm.
- **Executor refusal.** A refused job id is never in `running`, so it notifies at once. The test proves both slots come back.

### L1 safety: can it clear the slot of a job that is still running?

- **Same host, same data directory:** no. The executor's socket lock (`createLocalExecutor`, then `acquireLock`) refuses a second live process before the clear runs. `databasePath` and `jobsStateDir` are both derived from `MULTIX_DATA_DIR` (server-config.ts:54-66), so one database cannot be paired with two state directories.
- **Other nodes:** out of scope, as documented (one replica per volume). A ReadWriteOnce volume cannot attach to two nodes.
- **Residual risk, bare metal only:** after a hard crash (SIGKILL or OOM of node alone), CLI children are not killed, because they are not detached and no parent-death signal is set. The restart then clears their slots while they still run. In the image this cannot happen: tini exits when node exits and the PID namespace is torn down. Round 1 had the same exposure for server slots. This is the open bare-metal question from round 1, not a new defect.

### New or remaining findings

#### R2-1. Low: a CLI that ignores SIGTERM holds its executor slot until restart, and now holds its quota slots until the lease expires

- Where:
  - worker/container/job-runner.mjs `runCli`: `killSignal: "SIGTERM"`, used for both `timeout` and `signal`, with no SIGKILL escalation.
  - worker/container/local-executor.mjs:317-323: the notice is deferred until `slot.done` settles.
- Bound:
  - The quota slots are bounded by `JOB_SLOT_LEASE_MS`, 45 minutes from acquire (job-protocol.ts:77-85).
  - The executor slot (`running`) has no bound until the process restarts.
  - In round 1 a cancel released the quota at once; the executor slot was already unbounded then.
- Scenario: with `MAX_CONCURRENT=1`, a command whose child process traps SIGTERM keeps running after a cancel or the 30-minute deadline.
  - For 45 minutes the account and the whole server get `busy` or `server at capacity` from the quota.
  - After that the quota admits new jobs, but the executor refuses each one: it writes a refused record and publishes a failure event.
  - `/health/ready` stays 200, so no orchestrator restarts the pod.
  - The in-tree CLI's signal handlers do exit (music-live.ts, stdin-file.ts), so this needs a stuck process or a misbehaving child. That is why it is Low.
- Suggested fix:
  - In `runCli`, after the abort or timeout, send SIGKILL to the child once a grace period (for example 10 s) has passed without an exit.
  - Optionally spawn the CLI as its own process group (`detached: true`) and kill the group, so ffmpeg and magick children go too.
  - Both changes are internal to the runner and compatible with the job image rollout.
  - Optionally fail `/health/ready` when a slot has outlived `JOB_GIVE_UP_MS`.

#### R2-2. Low: the job image change silently switches Cloudflare `multix_run` image outputs to WebP

- Where: worker/container/Dockerfile:22 (`libwebp-tools` added).
- Evidence:
  - The CLI's `finalizeGeneratedImages` (src/core/image-webp-finalize.ts:146-165) converts with `cwebp -q 85` whenever `cwebp` is on PATH. Without it, it keeps the provider's format.
  - Until now the job image had no `cwebp`, so live Cloudflare jobs returned the provider's PNG or JPEG.
  - After the next container rollout the same request returns a lossy `.webp`, with a different object name and content type in R2.
- Compatibility: the job spec, the responses and the R2 key layout are unchanged, so the rollout-before-Worker rule is not broken.
- Why it is still a finding:
  - It is a user-visible change on the production Cloudflare path.
  - It ships in a `fix(server)` commit about the self-hosted server, with no note in the MCP server or REST docs.
  - AGENTS.md asks for a separate issue for a change outside the PR's scope.
- Scenario: a workflow or client that expects `.png` from `gemini generate`, or passes the output URL to a provider that rejects WebP input, breaks after the container rollout.
- Suggested fix: keep `imagemagick-jpeg imagemagick-webp` (pure capability). Then either:
  - move `libwebp-tools` in the job image to its own issue and commit, with docs ("outputs are WebP unless `no-webp`") and a changelog-visible type; or
  - state the change explicitly in this PR's Documentation impact and in docs-site/.../guides/mcp-server.md and rest-api.md.

#### R2-3. Low: the docs promise more than the code guarantees, and contradict themselves

1. **Contradictory grace-period guidance.** docs-site/src/content/docs/guides/self-hosted-server.md:265 says to give the orchestrator a grace period above "the larger of that timeout and 15 seconds". The deployment-contract table at line 302 (and vi line 299) still says only "above `MULTIX_SHUTDOWN_TIMEOUT_MS`".
   - Scenario: an operator sets `MULTIX_SHUTDOWN_TIMEOUT_MS=4000` and `terminationGracePeriodSeconds: 5`, which follows the table.
   - The job budget is then min(10 s, 2 s) + 5 s = 7 s, so the kubelet SIGKILLs the pod before `database.close()`.
   - The next start recovers (SQLite WAL, interrupted sweep, slot clear), but the documented order is not met.
   - Fix: make the table match line 265 in both languages.
2. **"Their slots are freed before the database closes" is not guaranteed.** That is true only for a CLI that exits within `closeTimeoutMs`.
   - A CLI that is slower than that gets its deferred `onFinal` after `database.close()`, and `job_slot_release_failed` is logged.
   - This is harmless now that start-up clears all slots.
   - Fix: change the wording to "freed before the database closes, or cleared at the next start".

### Recommended actions (round 2)

1. R2-2: decide whether the WebP switch on Cloudflare belongs in this PR. If it does, document it; if not, split it out.
2. R2-1: add SIGKILL escalation, and optionally kill the whole process group, in `runCli`. This can be a separate issue, since it changes the shared runner.
3. R2-3: align the grace-period table (en and vi) and soften the "freed before the database closes" claim.

No Critical, High or Medium findings remain.
