# Code review: merge of dev (egress proxy, S3 storage) into self-hosted jobs branch

Isolated review of merge commit 7051b0e. Verdict: no blocking defects.

- Every self-hosted runJob path forwards `egressEnv`: `local-executor.mjs` passes
  `egress.env`, and `cliRunner` in `worker/server/local-jobs.ts` hands it to
  job-runner's `runJob`. The only other caller, `job-server.mjs`, is the
  Cloudflare container and is unchanged by the merge.
- `job-runner.mjs` keeps both `killGraceMs` and `egressEnv`; `egressEnv` is
  spread after `spec.env`, and the proxy password is redacted.
- `local-executor.mjs` keeps dev's proxy start, verify, close and hand-off.
- Scripted check: every line added by either side is present and no removed
  line came back, apart from rewrapped comments and the combined llms.txt line.

Low-priority items and their resolution:

- The doc comment for `startLocalJobs` sat above `cliRunner`. Fixed: moved.
- The cliRunner test did not check that the proxy credential is redacted.
  Fixed: added a `not.toContain` assertion.
- `runJob: run as never` in `local-jobs.ts` bypasses type checking between the
  executor option and `RunJob`. Left as is: it predates the merge, and the
  cliRunner test covers the egressEnv hand-off at runtime.
