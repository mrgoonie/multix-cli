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
