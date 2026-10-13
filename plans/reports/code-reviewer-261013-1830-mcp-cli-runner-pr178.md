# Code review: PR #178 `feat/mcp-cli-runner` (multix_run in Cloudflare Containers)

Date: 2026-10-13 18:30 (Asia/Saigon) · Reviewer: isolated code-reviewer · Commit `e3ef29b` vs `origin/main`

## Scope
- 46 files, +13.7k LOC (≈10k of it is the generated `worker/src/cli-catalog.json`). Reviewed: `worker/src/jobs/**`, `worker/container/**`, wiring (`index.ts`, `mcp-server.ts`, `mcp-api-handler.ts`, `config.ts`), `wrangler.jsonc`, tests, README, EN/VI docs, SKILL.md.
- Verification run here:
  - `npm ci --prefix worker && npm run check:mcp`: typecheck OK, **272 passed / 3 skipped** (live smoke), wrangler 4.149 dry-run build OK (binding `MULTIX_JOBS`, container `multix-mcp-multixjobcontainer` resolved), bundle check clean.
  - `npm run lint`: clean (389 files).
  - Docker image not built (per instructions).
  - Adversarial argv probe: `prepareRun` + the real commander program (temp test file, removed afterwards).

## Verdict
**Approve with changes. No Critical findings.** Argument injection, secret handling and job ownership hold up under adversarial probing. Fix the two High items before deploying: per-account concurrency, and status/cancel restarting a dead container. The Medium items can land in this PR or as follow-up issues.

## What I verified holds (risk calibration)
- **Flag smuggling: not possible.** Every value goes in as `--name=value` and positionals go after `--`. With `enablePositionalOptions`, the root program hands `--` and everything after it to the leaf command unchanged. Results with the real program:
  - prompt `--output-dir=/etc` parses as `prompt: "--output-dir=/etc"`;
  - positional `--output=/etc/x` parses as `args: ["--output=/etc/x"]`;
  - `byteplus generate-3d --flags "--foo /etc/passwd"` stays one string (sent to the provider, not parsed as flags).
  - Short-flag clusters are never emitted. Option names are checked against the catalog after dashes are stripped, `help`/`version` are not in the option map, and the `output-dir` and `stdin-ext` options are rejected.
- **`@file` blocked.** `parseJsonInput` reads a file only on a leading `@`, and `checkText` rejects exactly that. `" @/etc/passwd"` is passed as literal text and fails JSON parsing. Values inside JSON `--input` payloads are never resolved as local paths; only `replicate run --file`, which is marked unsupported, does that.
- **File options.** Every `<path>`/`<file>`/`<paths...>`/`<pathOrUrl>`/`<path|url>`/`<spec>`/`<ref>` option is either a policy `fileOptions` entry or the output option. The policy-name test catches renamed options. Stdin `-` is reachable only through file options, so a caller cannot pass it. The CLI's `cwd/.env` loader cannot be fed, because inputs land under `in/` and `--output` must match `^[A-Za-z0-9]...` under `out/`.
- **Excluded commands.** `check` and `update` are excluded. `openai generate` and `openai image-to-image` are forced to `--driver api`; Codex is used nowhere else.
- **Secrets.**
  - Keys travel only in the RPC/POST body and the child env. `KEY_NAME_RE` restricts the env names the child gets.
  - Only the job id and status are logged. The spec is never persisted; DO storage holds only `JobView` with already-redacted text.
  - Redaction is applied twice: in the container (that job's env plus R2 credentials) and in the Worker (all saved keys plus R2 credentials).
  - Another account's keys are never in scope: one DO and one microVM per job, and `jobEnv` takes the group's keys from the caller's own `ProviderKeys`.
- **Ownership.** Job ids are `crypto.randomUUID()`. Status/cancel check `JOB_ID_RE` and the KV owner before any DO call; a foreign job gets the same "Job not found" as a missing one.
- **R2.**
  - `safeOutputName` takes the basename and rejects `.`/`..`; `encodeKey` rejects empty and dot segments.
  - Unknown extensions get `application/octet-stream`, so `.html`/`.svg` outputs cannot become stored XSS on a public bucket.
  - Presigned URLs expire after 604800 s, the SigV4 maximum.
  - `R2UploadError` carries only the status and S3 error code.
- **wrangler 4.149.** Linking the container with `containers[].class_name` and `exports.<Class>: {type: durable-object, storage: sqlite}` is accepted (wrangler cli.js validation around line 28726; the dry-run passes). `main` has no existing `migrations`, so the mutual-exclusion rule does not bite.
- **Lifecycle basics.**
  - `finish()` saves the terminal view before `destroy()`.
  - `onStop` after `finish` is a no-op.
  - Polling every 5 s renews `sleepAfter` through `containerFetch`, so `sleepAfter` only matters if polling stops, and then it acts as a cleanup backstop.
  - The job server refuses a second POST with 409.

## Critical
None.

## High

### H1. No per-account concurrency limit: one account (or one runaway agent loop) can hold every container for about 45 minutes
- **Where:** `worker/wrangler.jsonc:56` (`max_instances: 10`, global); `worker/src/jobs/job-runner.ts:113-131` (no admission check).
- **Failure scenario:**
  - An agent retries `multix_run` in a loop. `MCP_RATE_LIMITER` allows 60 calls/min per account, so 10 calls fill all 10 instances.
  - Each instance can live up to `JOB_TIMEOUT_MS + UPLOAD_GRACE_MS` = 45 min.
  - Every other account's `multix_run` then fails with the generic "The job container could not be started" (the NoInstance error is swallowed at `job-controller.ts:69`), and billing runs for all 10 instances.
  - Sign-in is allowlisted, which lowers the likelihood, but a leaked OAuth token or a buggy client is enough.
- **Fix (minimal):** cap active jobs per account (e.g. `MULTIX_MCP_MAX_ACTIVE_JOBS`, default 2), checked before `store.create`.
  - *Atomic (preferred):* a tiny SQLite DO `AccountJobQuota`, one per account (`getByName(userId)`), with `acquire(jobId)` / `release(jobId)` and entries that expire after 50 min. Add it to `exports`. `MultixJobContainer.finish` calls `release`; pass `userId`, which is not a secret, in `startJob`.
  - *Best-effort:* KV `active:<userId>:<jobId>` with `expirationTtl` 3000 s. Count with `kv.list({prefix})` before starting, and delete the key when the Worker sees a terminal status. KV list consistency is eventual (about 60 s), so a burst can overshoot slightly; the rate limiter bounds this.
  - Also map the NoInstance/429 start failure to a distinct message ("server busy, retry later") so callers back off instead of retrying blindly.

### H2. Status/cancel on a dead container restarts it (`containerFetch` auto-starts)
- **Where:** `worker/src/jobs/job-controller.ts:114` (`refresh`) and `:95` (`cancel`), via `multix-job-container.ts` `fetchContainer`. In `@cloudflare/containers` 0.3.7, `containerFetch` (`container.js:864-871`) calls `startAndWaitForPorts` whenever the container is not running or healthy.
- **Failure scenario:**
  - The container crashes or is evicted mid-job. Before `syncPendingStoppedEvents` fires `onStop`, a `multix_job_status` call (or the 5 s poll) goes through `refresh` and boots a fresh container from the full ffmpeg/ImageMagick image. That takes a `max_instances` slot and blocks the RPC for up to 60 s.
  - The new job server answers `idle`, the job is marked failed, and the container is destroyed.
  - A `cancel` that races `finish()` boots a container just to send SIGTERM to nothing.
  - When instances are exhausted, every poll is a failed start attempt, which makes H1 worse.
- **Fix:** do not auto-start outside `start()`. In the DO port, expose `isRunning()` (`this.ctx.container?.running`, or `(await this.getState()).status` in `running`/`healthy`). In `refresh`, return `failed` ("container stopped") when it is not running. In `cancel`, skip the fetch and just finish. Alternatively, call `this.container.getTcpPort(port).fetch(...)` directly, which never starts the container. Add a controller test where `fetchContainer` must not be called after `stopped`.

## Medium

### M1. Container input download: SSRF guard checks host names only, so DNS rebinding works
- **Where:** `worker/container/job-inputs.mjs:49-71` and `:95-111`.
- **Failure scenario:**
  - The container, not a provider, now fetches caller URLs. The Worker-side comment ("a public name pointing at a private address is the provider's network boundary", `url-guard.ts:1-7`) therefore no longer holds.
  - A caller passes `https://x.attacker.tld/a.png` that resolves to a private or link-local address (any wildcard-DNS service, or a redirect target that resolves privately). The body is downloaded, handed to the CLI, and may come back through outputs/stdout (e.g. `media optimize` writes it to `out/` and uploads it).
  - Reach is limited to port 443 and to whatever the container network exposes, which is not documented; the research report flags egress hardening as untested. This is defense in depth, not a proven exploit.
- **Fix:** in the container, resolve before connecting and pin the address. Use an undici `Agent({ connect: { lookup } })` (or `dns.lookup(host, {all: true})` plus a check) that rejects loopback, RFC1918, CGNAT 100.64/10, link-local 169.254/16 and fe80::/10, ULA fc00::/7, ::ffff:mapped private, 0.0.0.0/8 and multicast. Apply it on every redirect hop. Optionally also set `deniedHosts` CIDRs on the Container once `interceptHttps` has been tested.

### M2. Output upload buffers up to 500 MB in a 1 GiB `basic` instance
- **Where:** `worker/container/job-runner.mjs:16`, `:149` (`readFile(file)`), and `r2-upload.mjs:91` (aws4fetch hashes the whole body to sign it).
- **Failure scenario:** a large `media split` or video output of a few hundred MB, plus the signing digest copy, plus the fetch body copy, crosses about 1 GiB. The job server is OOM-killed, the DO marks the job "container stopped", every output is lost, and the provider spend is wasted.
- **Fix:** either lower `MAX_UPLOAD_BYTES` to about 200 MB (matching the input cap) and return `url: null` with a note above that, or stream: sign with `x-amz-content-sha256: UNSIGNED-PAYLOAD` (R2 accepts it), pass a file `ReadableStream` with `duplex: "half"`, and set `content-length`.

### M3. Container work is not bounded by the DO's 45-minute deadline
- **Where:** `job-inputs.mjs:15/123` (120 s per file × 10 files = 20 min before the CLI starts); `job-runner.mjs:179` (CLI capped at 30 min on its own); `r2-upload.mjs:98` (300 s per upload × up to 50 files); `job-controller.ts:33/125` (DO gives up at 30 + 15 min).
- **Failure scenario:** slow inputs (about 15 min) plus a long video CLI run (about 30 min) push past 45 min. The DO marks the job `timed_out` and destroys a container that was about to upload valid outputs. Worst-case upload time is also unbounded relative to the DO deadline.
- **Fix:** give `runJob` one overall deadline, e.g. `AbortSignal.any([options.signal, AbortSignal.timeout(spec.timeoutMs + 10 min)])` shared by download, CLI and upload. Give the CLI the remaining time (`deadline - now`) rather than a flat 30 min. Keep the DO grace slightly above that total.

### M4. Filename-component options let output escape `out/`
- **Where:** policy gap in `worker/src/jobs/cli-command-policy.ts` (no rule) for:
  - `elevenlabs voices design --output-prefix <p>` (CLI: `src/providers/elevenlabs/commands/voices.ts:131`, joined through `saveBytes` at `client.ts:214`);
  - `elevenlabs dub-status --download <lang>` and `elevenlabs dub --target-lang` (`dub.ts:105,127`).
- **Failure scenario:** confirmed by probe: `--output-prefix=../../../../tmp/pwn` passes `prepareRun` and commander. `path.join(outDir, "elevenlabs_../../../../tmp/pwn_…")` writes outside `out/`. Impact is low in practice: the microVM is per job, writes run as non-root, and `/app` and `/job-server` are root-owned. But it breaks the "output locations belong to the server" invariant, and the file is silently not uploaded. `opts.download` is also spliced unescaped into the ElevenLabs URL path, though only with the caller's own key.
- **Fix:** add a policy kind such as `nameOptions` that requires `^[A-Za-z0-9_-]{1,64}$`, covering `output-prefix`, `download` (dub-status) and `target-lang`. Extend the "path-like placeholder" test to also flag `<p>`, `<lang>` and `<code>` when the option feeds a filename, or require each such option to be listed explicitly. Separately, open a CLI issue to sanitize filename parts in `saveBytes` and the dub commands.

### M5. Repeatable options without an array default are treated as single-value
- **Where:** `worker/src/jobs/cli-catalog.ts:44` (`isRepeatable = variadic || Array.isArray(default)`), which feeds `run-argv-builder.ts:81,103`.
- **Failure scenario:** these options say "repeatable" but use a collector parser with no default:
  - `heygen video-agent --file` ("repeatable, max 20");
  - `heygen model-video --reference-image`, `--reference-video`, `--reference-audio`.

  `options.file: ["asset:a","asset:b"]` fails with "takes a single value" (confirmed), and `inputs.file` with 2 URLs fails with "takes a single URL". The docs say "a list for an option that repeats", so these features are silently broken remotely.
- **Fix:** have `cli-catalog-builder.ts` record `repeatable: true` when the option has a custom `parseArg` and a "repeatable" description, or more robustly add a policy `repeatable: [...]` override. Add a test asserting that every option whose description says "repeatable" is repeatable in the index.

## Low

### L1. Truncation happens before redaction
- **Where:** `job-runner.mjs:184-185`.
- A key that straddles the 16 KB cut is only partly redacted: the prefix survives, and the Worker's exact-match scrub cannot catch the fragment. The exposure is to the key's owner only, but transcripts persist.
- **Fix:** `head(redact(stdout))` and `tail(redact(stderr))`.

### L2. Exceeding `maxBuffer` is reported as `timed_out`
- **Where:** `job-runner.mjs:102,187`.
- When the 16 MB `maxBuffer` is exceeded, Node kills the child and sets `killed`, so the result says `timed_out`.
- **Fix:** check `error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` and report `failed` with a clear error.

### L3. The `multix_run` call can block 110 s or more
- **Where:** `job-runner.ts:126-127`.
- The `wait_seconds` deadline starts after `backend.start()`, which includes a cold start of up to 60 s (`portReadyTimeoutMS`). Many MCP clients time out around 60 s.
- **Fix:** compute the deadline before `start()`, or default `wait_seconds` lower on a cold start.

### L4. `start()` can overwrite a terminal state set by a concurrent `onStop`
- **Where:** `job-controller.ts:72-73`.
- `start()` saves `running` without re-reading, so a terminal state written by a concurrent `onStop` (container died right after the 202) is overwritten. The next poll then auto-starts a new container (see H2) to find out it is idle.
- **Fix:** re-`load()` before saving `running`, and skip the save if the stored status is terminal.

### L5. `expireJob` leaves DO state behind
- **Where:** `multix-job-container.ts` `expireJob`.
- It deletes only `job`. The container state key and the `container_schedules` table remain in the per-job DO forever. The cost is negligible, but `ctx.storage.deleteAll()` would be cleaner.

### L6. Docs nits
- `multix_run` never returns `starting` (the start RPC waits until `running` or terminal), but the docs list it.
- The output caps (at most 50 files, 500 MB per file) are not documented; "Every file the CLI writes is uploaded" overstates.
- **Positive:** the VI docs match the EN docs on all numbers and claims.

### L7. Catalog freshness test: the path-like regex lets new placeholders through
- **Where:** `worker/test/cli-catalog.test.ts:50`.
- The test is meaningful: it diffs against the real commander tree and checks that every policy name exists. But a new path option using an unseen placeholder (e.g. `<input>` or `<fileOrUrl>`) would pass silently.
- **Fix:** invert the rule. Fail on any `<…>` option whose description mentions "file", "path" or "directory" unless it is covered or explicitly allowlisted.

## Scout / edge-case notes
- `heygen run` / `fal run` / `atlas run` and destructive commands (`elevenlabs voices delete`, `replicate cancel`) are reachable. They act only on the caller's own provider account with the caller's own key, so this is acceptable. Mention it in the docs if desired.
- KV ownership records are eventually consistent across colos, so a status call routed to a different POP in the first ~60 s may get "Job not found". It is unlikely, because the same POP normally serves the session.
- If the Worker → DO `startJob` RPC throws after the container accepted the job, the job runs to completion without a returned id. This is a billing-only issue, and H1's quota bounds it.

## Recommended actions (priority)
1. H1: per-account active-job cap, plus a distinct "busy" error.
2. H2: never auto-start the container from `refresh`/`cancel`.
3. M1: DNS-pinned private-IP rejection in the container download.
4. M2/M3: streaming or lower upload cap; one overall job deadline.
5. M4/M5: policy for filename-part options and repeatable overrides (open a CLI issue for the `saveBytes` sanitizing).
6. Low items as convenient.

## Plan follow-up (phase 2, #174)
- Done: catalog generator plus freshness test, `multix_run` validation and caps, KV ownership, DO per job with result persisted before destroy, job server (no shell, temp dir, redaction, 16 KB truncation), Dockerfile (non-root, multi-stage), wrangler config, EN/VI docs, SKILL.md.
- Not evidenced: deploy plus a live run with redacted output. The PR body claims a local `docker build` and a `media optimize` smoke run, but there is no deployed-run evidence yet. Per-account concurrency is not addressed (the plan says only "max_instances modest").

## Metrics
- Typecheck: clean (worker + tests). Lint: 0 issues. Tests: 272 passed / 3 skipped. Coverage: not measured.

## Unresolved questions
1. What can a Cloudflare Container reach on private ranges or link-local (169.254.x) without `interceptHttps`? This decides whether M1 is defense in depth or a real exposure.
2. Intended per-account concurrency (1? 2?) and whether allowlisted users are fully trusted for cost.
3. Should the remote runner expose provider-account-mutating commands (`voices delete`, `heygen run`, `replicate cancel`), or limit itself to generation/analysis?
4. Has a deploy-time live run been done (plan validation step), and with which instance type for media-heavy jobs?

## Resolution

Date: 2026-10-13 19:05 (Asia/Saigon). Commit: `fix(mcp): cap concurrent jobs per account and harden the container runner` on `feat/mcp-cli-runner`.

| Finding | Resolution | Evidence |
|---|---|---|
| H1 per-account cap | New SQLite DO `AccountJobQuota` (`worker/src/jobs/account-job-quota.ts`), one per account via `MULTIX_JOB_QUOTA.getByName(userId)`. `acquire(jobId)` and `release(jobId)` run inside the DO, so storage get/put cannot interleave (strongly consistent). The cap is 2. Every slot carries a lease, `JOB_SLOT_LEASE_MS` = 45 min, which is longer than the 35-min DO give-up time. The slot is released: in `JobController.finish` (any terminal state: done, failed, canceled, timed out, container stopped, start failure, capacity); by the Worker when the start RPC throws; otherwise when the lease expires. Error messages: `busy: you already have 2 running jobs; …`. A NoInstance or rate-limited start becomes `ContainerCapacityError` and is surfaced as a separate tool error, `server at capacity: …`. Wiring: binding and export added in `wrangler.jsonc`; class exported from `index.ts`; the job tools need both bindings. | `account-job-quota.test.ts` (3): takeSlot, lease expiry, DO acquire/release. `job-tools.test.ts`: busy cap per account (another account is unaffected); capacity error; slot released when start throws. `job-controller.test.ts`: release on finish, on failure and on capacity. |
| H2 dead container restarted | The DO port gained `isContainerRunning()` (`ctx.container.running`). `fetchContainer` now calls `ctx.container.getTcpPort(8080).fetch` directly with a 10 s timeout and never boots a container; only `start()` calls `startAndWaitForPorts`. When the container is not running, `refresh` finishes the job as failed. `cancel` skips the request and finishes the job. | `job-controller.test.ts`: "never boots a container to read or cancel a job whose container is gone" (no extra start, no request). |
| M1 DNS rebinding | New `worker/container/job-network.mjs`. `isPublicAddress` rejects these ranges: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, TEST-NETs, 192.168/16, 198.18/15 and 224+; IPv6 ::, ::1, IPv4-mapped/NAT64/6to4 that embed a private v4, fc00::/7, fe80::/10, fec0::/10, ff00::/8 and 2001:db8::/32. `createPublicLookup` resolves with `all: true`, refuses the connection if any address is not public, and connects only to the checked addresses: the pin happens at socket connect, so there is no TOCTOU gap. `publicHttpsGet` uses `node:https` with `agent: false` and does not follow redirects. Downloads follow redirects by hand (at most 5) and check the host and the address again on every hop. | Tests: address table; lookup that mixes private and public addresses; https request through the lookup is rejected with `EBLOCKEDADDRESS`; redirects (5 succeed, 6 fail); rebinding error. Docker smoke run: `https://localtest.me/` (public name resolving to 127.0.0.1) was blocked with `EBLOCKEDADDRESS`. |
| M2 upload OOM | New `job-outputs.mjs` streams each file (`Readable.toWeb(createReadStream)`) with `content-length` and `duplex: "half"`. The request is signed with `x-amz-content-sha256: UNSIGNED-PAYLOAD`, so the body is never hashed or buffered. The cap stays at 500 MB per file (now safe on disk) and 50 files. | Test: the PUT body is streamed and `content-length` equals the file size. On the image's Node 22.23.3, a stream with explicit content-length is sent unchunked. |
| M3 shared deadline | `runJob` takes one `AbortSignal.timeout(min(spec.timeoutMs, 30 min))`, combined with cancel, and uses it for downloads, the CLI and uploads. The CLI gets the remaining time minus an upload reserve of min(5 min, budget/4). Hitting the deadline reports `timed_out`. The DO gives up after `JOB_GIVE_UP_MS` (30 + 5 min). `sleepAfter` is 40 min. | Test: a stalled download times out the job within the deadline (`timed_out`, with its own message). |
| M4 file-name parts | New policy `nameOptions` requiring `^[A-Za-z0-9_-]{1,64}$`. It covers `elevenlabs voices design --output-prefix`, `elevenlabs dub --target-lang` and `elevenlabs dub-status --download`, found by auditing CLI sources for option values joined into paths (`voices.ts:131`, `dub.ts:105,127`; `openai-image.ts:85` uses an internal `task`, not an option). `multix_catalog` reports `format`. | Tests: three rejection cases (`../` in each) and two accepted cases (`narrator_v2`, `pt-BR`). |
| M5 repeatable | New policy `repeatable`, read by `isRepeatable(option, policy)`: `heygen video-agent --file`, and `heygen model-video --reference-image/-video/-audio`. | Tests: argv parsed by real commander gives `opts.file == [a, b]`; two `inputs` URLs for `reference-image`. New catalog test: every option whose description says "repeatable" must be repeatable. |
| L1 | Output is redacted before it is truncated. | Test: a key across the 16 KB cut leaves no fragment. |
| L2 | `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` now gives `failed` with "wrote more than 16 MB". | Test with a fake CLI that floods 20 MB. |
| L3 | The `wait_seconds` deadline now starts before `start()`; max is 40 (default 25). Container start is bounded at 15 s to get an instance and 30 s for the port. A call returns within about max(start, wait) plus one status read. | Test: a 30 s cold start counts against `wait_seconds` 40. |
| L4 | `start()` reloads the state before saving `running` and keeps a terminal state recorded meanwhile. `status()` also fails a job stuck in `starting` for over 5 min. | Two controller tests. |
| L5 | KV TTL is 7 days; the DO alarm `expireJob` deletes the `job` and `slot` keys. `deleteAll()` was deliberately not used: @cloudflare/containers runs `DELETE FROM container_schedules` right after the callback (container.js ~1549), which would throw once the table is dropped. The library's internal state key remains, a few bytes. | Not unit-tested (runtime only). |
| L6 docs | `starting` removed from the documented `multix_run` statuses. Documented: output caps (50 files, 500 MB), the per-account cap with both errors, the 30-min shared limit, `wait_seconds` 0–40 including start, name-part options, the decision on account-mutating commands, the DNS guard and redaction order, and the `MULTIX_JOB_QUOTA` binding. Updated in EN/VI guides, README and SKILL.md. | `npm run verify:docs` 7/7 pass. |
| L7 catalog test | Rule inverted: any value option whose placeholder or description mentions file/path/dir/folder/filename/prefix/local must be a file input, output, name part or unsupported, or carry an allowlisted placeholder (`<json>` because `@` is rejected, `<id>`, `<str>`, `<MB>`). | `cli-catalog.test.ts` (5). |

Decision applied: account-mutating commands (voices delete, heygen run) stay allowed, and the docs say they use the caller's own key.

Verification:
- `npm run check:mcp`: typecheck clean, 293 passed / 3 skipped; bundle check clean (bindings `MULTIX_JOBS` and `MULTIX_JOB_QUOTA`).
- `npm run lint`: clean.
- `npm run verify:docs`: 7/7.
- `docker build -f worker/container/Dockerfile .`: OK.
- Smoke run: `media optimize` with a real https input succeeded and left `/tmp` clean.

Remaining:
- Per-account cap is a constant (2), not configurable.
- The heuristic in the inverted path test only catches options described with file words: `--target-lang <code>` is covered by policy but would not have been flagged.
- Not exercised on real Cloudflare: Containers egress, `ctx.container.getTcpPort` without `containerFetch`, and the NoInstance message match.
- CLI-side hardening of `saveBytes` and the dub filenames should get its own issue.
