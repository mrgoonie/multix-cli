# Code review: Kubernetes Job executor (HEAD c83b3e6)

## Scope
- Files: worker/container/k8s-job-runner.mjs (new, 537 LOC), local-executor.mjs (+5), local-jobs.ts, server-config.ts, multix-server.ts, server/k8s/job-executor.yaml, tests, docs (en + vi), README, AGENTS.md
- Focus: duplicate charges, secret leakage, cancel/shutdown/slot races, NetworkPolicy, RBAC, K8s API correctness, timeouts, docs accuracy
- Checks run: `vitest run test/k8s-job-runner.test.ts server/test/server-config.test.ts` (19/19 pass), biome on changed files (clean), `tsc -p tsconfig.server.json` (clean)

## Overall assessment
The core invariants hold. The spec is POSTed once and never retried. The Job has `backoffLimit: 0` and `restartPolicy: Never`, and a replacement pod could not bill anything because the spec only reaches a pod through that single POST. The manifest uses only `jobId` and `timeoutMs`, so no secret lands in a K8s object. Restart recovery runs `sweep` (interrupted) before `prepare` (delete leftovers). RBAC verbs match the calls; `deletecollection` is not used or granted. API paths, label selectors and `propagationPolicy=Background` are correct, and pod readiness checks Running, podIP and Ready=True. No critical issues. The findings below are edge-case gaps in slot accounting, pod identity, and the NetworkPolicy and RBAC threat model, plus docs claims that go beyond what the code does.

## Critical
None.

## High
None.

## Medium

### M1. POD_LOST frees the slot while the pod may still run the CLI (and bill)
- k8s-job-runner.mjs:469-470. After 30 failed polls (`MAX_POLL_FAILURES`) while `podStillThere()` is still true, `runJob` returns `POD_LOST_ERROR` without calling `stop()`: no `/jobs/current/cancel`, no `waitPodsGone`. Only the `finally` `deleteJob` (Background, line 477) runs.
- Scenario: the server-to-pod path breaks (CNI hiccup, policy change, pod CPU-throttled under ffmpeg at the 1-CPU limit, so GETs time out). Each failed GET can take up to `REQUEST_TIMEOUT_MS` (30 s), so this happens after anywhere from about 30 s to about 15 min. The executor records the job as failed, releases the account and server slots, and starts the next job. Meanwhile the old pod keeps running its provider calls for up to its 15 s grace (longer if Job deletion fails), so `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` is exceeded. The record says "failed" even though the CLI may finish and upload outputs.
- This contradicts the header (lines 22-24) and the docs ("the slot is freed once the pod is gone").
- The test "a pod that stops answering while running fails the job as lost" (test/k8s-job-runner.test.ts:317) cannot catch this: the fake cluster deletes pods at the same moment as the Job (test line 82-84).
- Fix: on the lost path with the pod still present, `return` after `await stop(jobId, ip)`, and only skip `stop` when the pod list says the pod is gone. Make the fake cluster keep pods for a few polls after Job deletion so the test proves the wait.

### M2. A 409 from the pod counts as "accepted": another sender's job is adopted as this job
- k8s-job-runner.mjs:444, `accepted = response.status === 202 || response.status === 409`.
- The runner POSTs exactly once to a fresh pod, so a 409 (job-server.mjs:57/63, "A job already ran in this container") can only mean someone else POSTed first. The runner then polls and returns that other job's `result` (stdout, outputs) as the caller's job.
- Scenario: NetworkPolicy not enforced (the docs admit the server cannot check this), or another pod in the namespace carries `app.kubernetes.io/name: multix-server`. That pod races the server between pod Ready and the server's POST and submits its own spec. The victim's record then carries attacker-chosen output and status. Keys do not leak, but integrity is lost. job-server has no authentication, and `/jobs/current` does not return the jobId, so the runner cannot detect this.
- Fix: treat 409 as not accepted (`NOT_ACCEPTED_ERROR`) and `stop()` the pod. As defense in depth, have job-server return `jobId` in `/jobs/current` and check `current.result`/`jobId === spec.jobId` before accepting a result. This is an additive response field, so it is compatible with the DO path under the container rollout rule.

### M3. NetworkPolicy does not block cluster addresses outside RFC1918/ULA (IPv6 GUA clusters, non-private pod CIDRs)
- server/k8s/job-executor.yaml:84-106. The egress allow is `0.0.0.0/0` / `::/0` minus special-use ranges.
- On IPv6 clusters with global unicast pod/service addresses (for example EKS IPv6, which assigns pods VPC GUAs), or on IPv4 clusters with non-RFC1918 pod/service CIDRs (privately used public ranges, as GKE allows), job pods can reach every pod and service in the cluster. That includes the server's own port and any in-cluster database. Job pods run caller-controlled argv and fetch caller-supplied input URLs, so this is SSRF into the cluster.
- The docs (self-hosted-server.md, "never pod, service, node ... addresses") state this as a guarantee. The yaml comment only asks operators to add the API server, node and metadata addresses, not the pod and service CIDRs.
- Fix: in the yaml comment and both docs pages, tell operators to add the cluster's pod and service CIDRs (and node CIDR) to `except` when they are not covered, and soften the "never" claim.

### M4. "Cannot read Secrets" is inaccurate: `jobs: create` lets the server run a pod that mounts any Secret or service account in the namespace
- job-executor.yaml:18-19 comment ("It cannot read Secrets or touch other workloads"), plus the docs step 1 wording.
- Creating a Job means creating a pod with any spec. A compromised server process (it serves public MCP/HTTP) can start a Job that mounts every Secret in the namespace or runs under any ServiceAccount there and exfiltrates over the public egress.
- Fix: recommend a dedicated namespace for multix-server and its jobs, and label it `pod-security.kubernetes.io/enforce: restricted`. The job manifest already meets the restricted profile (runAsNonRoot, seccomp RuntimeDefault, drop ALL, no privilege escalation), so that bounds what a hijacked Job can be. Correct the comment and docs.

## Low

### L1. Shutdown can exit before the Job is deleted
- local-executor.mjs:545-550 waits `closeTimeoutMs` (≤ 10 s, multix-server.ts) for `slot.done`.
- An abort is only seen between polls (k8s-job-runner.mjs:451/472). A GET `/jobs/current` already in flight is not abort-aware and can take up to 30 s (`REQUEST_TIMEOUT_MS`), and `stop()`'s cancel POST has the same bound.
- Scenario: the pod is slow to answer at SIGTERM. The server exits without cancelling or deleting the Job, and the CLI keeps running (and billing) until `activeDeadlineSeconds` (up to ~38 min with the 30 min max) or until the next server start's `removeLeftoverJobs`.
- Fix: pass `signal` into `podHttp` and abort in-flight pod GETs. Use a short timeout (~2-3 s) for cancel/GET during `stop()`.

### L2. Results are not tied to a pod identity (pod IP reuse)
- k8s-job-runner.mjs:458, 384. Polls and cancels go to a cached IP, and the response is not checked against the jobId.
- If the pod disappears and its IP is reassigned to another job pod of this server before a failed poll triggers `podStillThere`, the runner could read another user's result or cancel another user's job. The window is small: the next failed poll checks the pod list, and evicted pods stay listed as `Failed`.
- Same fix as M2: return and check `jobId` in `/jobs/current`.

### L3. Slot freed before the pod is gone on the success, start-timeout and POD_FAILED paths
- k8s-job-runner.mjs:437, 464, 477. `finally` deletes with Background and does not wait.
- No CLI is running on these paths, so nothing is billed. Still, CPU and memory of terminating pods add up against namespace ResourceQuota, and the next job's pod may then sit Pending until the 5 min start timeout. Acceptable; noted against the docs claim.

### L4. DNS rule breaks under NodeLocal DNSCache
- job-executor.yaml:72-81. The rule allows DNS only to `kube-system` pods labelled `k8s-app: kube-dns`, and 169.254.0.0/16 is excluded.
- With NodeLocal DNSCache (169.254.20.10, or the kube-dns ClusterIP intercepted on the node, for example on GKE), DNS is denied and every job fails at runtime.
- This fails closed, so it is not a security problem. Document it (allow the node-local DNS IP on port 53) in the yaml comment and the docs.

### L5. `verify()` checks only selection and policyTypes, not rule content
- k8s-job-runner.mjs:504-510. A policy with `egress: [{}]` (allow all) passes. Its tests also use a hand-written object, not the shipped yaml (test:330-341), so the yaml and the test can drift.
- The docs describe exactly what is checked, so this is not a docs error. Optionally parse job-executor.yaml in the test.

### L6. Unused RBAC verbs
- job-executor.yaml:25-28 grants `jobs: get` and `pods: get`. The code uses only jobs create/list/delete, pods list and networkpolicies get. Harmless but not minimal. `deletecollection` is correctly absent.

### L7. `MULTIX_JOB_EXECUTOR=kubernetes` without `MULTIX_LOCAL_JOBS=true` is silently ignored
- multix-server.ts:45. Documented as "needs MULTIX_LOCAL_JOBS=true", but a warning or startup error would catch the misconfiguration.

## Docs accuracy
- "the slot is freed once the pod is gone": false on the POD_LOST path (M1), on shutdown (L1), and after `waitPodsGone`'s 60 s give-up.
- "never pod, service, node ... addresses": conditional on address ranges (M3).
- yaml "cannot read Secrets": inaccurate (M4).
- "removes finished Jobs after 5 minutes, even if the server is gone": job-server never exits after its job, so an orphaned Job only "finishes" at `activeDeadlineSeconds` (DeadlineExceeded), then TTL applies. Technically true, but it implies a faster cleanup than happens.
- The server's ingress label `app.kubernetes.io/name: multix-server` differs from the existing example Deployment's `app: multix-server`. The docs say to add it (step 2), but the example Deployment YAML is not updated, so copying it leaves the job port unreachable (jobs fail at start). Suggest showing the label in the example.
- The vi page mirrors the en section (checked structure and variables).

## Edge cases checked and confirmed OK
- A lost POST answer is not repeated; `/jobs/current` decides. job-server sets `current` synchronously after the body is read, so a later GET sees it.
- Cancel before Ready never sends the spec (line 433-436).
- A Job-create error or timeout deletes the Job, and no spec has been sent yet. A 409 on create returns without deleting the existing Job.
- `KubernetesApiError` strips the query string. Errors are mapped to `RUNNER_FAILED_ERROR` by the executor, so no stack or secret reaches the record.
- `workerVars` keeps `MULTIX_K8S_*` / `MULTIX_JOB_EXECUTOR` out of the Worker env.
- Job name: 47 chars, under 63. jobId label value: 36 chars, valid.
- Read-only rootfs works: job-runner sets `HOME` to its mkdtemp dir under /tmp, and the image user `node` is uid 1000.
- A failing `prepare` releases the lock (tested).

## Recommended actions (priority order)
1. M1: call `stop()` on the lost path, and fix the fake cluster so pods outlive the Job.
2. M2: treat 409 as not accepted, and add `jobId` to `/jobs/current` and check it (also covers L2).
3. M3/M4: correct the yaml comments and docs (pod/service CIDRs, dedicated namespace plus PSA restricted, the Secrets claim).
4. L1: make pod GETs abort-aware and use short timeouts inside `stop()`.
5. Docs: add the ingress label to the example Deployment, and mention NodeLocal DNSCache.

## Metrics
- Tests: 19/19 pass. No coverage run. Gaps: POD_LOST pod-still-running, a 409 from the pod, shutdown timing.
- Lint: 0 issues on changed files. Typecheck (server tsconfig): clean.

## Unresolved questions
- Is a dedicated namespace an acceptable hard requirement for this executor, or only a recommendation?
- Should job-server get an optional per-job token (env on the Job) to authenticate the server even when NetworkPolicy is not enforced?
