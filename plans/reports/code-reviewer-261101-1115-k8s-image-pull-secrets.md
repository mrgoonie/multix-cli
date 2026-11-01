# Code review: MULTIX_K8S_JOB_IMAGE_PULL_SECRETS (#566)

Scope: diff vs origin/dev (also committed as 583a31f on claude/relaxed-clarke-o3k9aw). Files:
worker/container/k8s-job-runner.mjs, worker/test/k8s-job-runner.test.ts, worker/server/server.env.example,
docs-site/src/content/docs/guides/self-hosted-server.md and vi/ counterpart.

## Verdict

No blocking findings. Approve after the Medium doc fix below, or accept it as-is with that caveat.

Checks run: `npx vitest run test/k8s-job-runner.test.ts` in worker/ (22/22 pass); `biome check` on the two
changed code files is clean.

## Findings

### Medium: "Unset" sentence in the docs is wrong for some clusters
docs-site/src/content/docs/guides/self-hosted-server.md:451 (and vi/ :448): "Unset, the job pods have no pull
Secret and the image pulls with the nodes' own credentials". The Job pod sets no `serviceAccountName`
(k8s-job-runner.mjs:282-296), so it runs as the namespace's `default` ServiceAccount. The ServiceAccount
admission controller copies that ServiceAccount's `imagePullSecrets` into any pod that has none. So when the
variable is unset, the pods do get pull Secrets if `default` has them. The reverse also holds and is worth a
sentence: once the variable is set, the ServiceAccount's pull Secrets are no longer added, so the list must
include every Secret the image needs. Suggested wording: "Unset, the job pods use the pull Secrets of the
namespace's `default` ServiceAccount, if any, or the nodes' credentials. Set, this list replaces them."

### Low: the docs name only the dockerconfigjson Secret type
self-hosted-server.md:451. The kubelet also accepts the legacy `kubernetes.io/dockercfg` type. This is harmless
as guidance, since dockerconfigjson is the recommended type. Optional fix: write "e.g. `kubernetes.io/dockerconfigjson`".

### Low: test gaps (not blocking)
worker/test/k8s-job-runner.test.ts:203-225. No test shows that a 253-character name or a multi-label dotted name
(`a.b.c`) is accepted. The 254-character rejection only proves the upper bound. Also, "a b" would already
be rejected by the regex. Add a positive 253-character case so a future off-by-one fails.

## Verified (no issue)
- Validation matches the Kubernetes DNS-1123 subdomain rules for Secret names. Allowed: lowercase alphanumerics,
  `-` and `.`. Each label must start and end with an alphanumeric. The total limit is 253 and there is no
  per-label 63 limit, which is correct for subdomains (k8s-job-runner.mjs:86, 141-147). The length check
  short-circuits before the regex. The input is operator-controlled env, so regex backtracking is not a concern.
- Blank and whitespace entries are dropped, the order of first occurrence is kept, and duplicates are removed
  (133-140). An empty or unset value gives `[]`, and the manifest then has no `imagePullSecrets` key at all
  (294-296), as the tests at :256 and :271 confirm. The manifest is unchanged when the variable is unset.
- No Secret contents leak. The server only puts the names into the Job object, never reads the Secret, and logs
  nothing about the settings. The error message does not echo the value.
- RBAC: worker/server/k8s/job-executor.yaml grants only jobs, pods and networkpolicies. A pod that references a
  pull Secret needs no Secret access from whoever creates it, because the kubelet fetches the Secret through
  the node authorizer. No Role change is correct.
- Other callers: the only production caller is worker/server/local-jobs.ts:180, which passes the result
  straight to createKubernetesJobRunner, so it is compatible. `MULTIX_K8S_*` is already handled as server-only
  in worker/server/server-config.ts:119, so the new variable is not forwarded to job processes.
- Docs: the EN and VI rows match each other. server.env.example has the example commented out. No other living
  surface lists MULTIX_K8S_* variables (README, skill/ and llms.txt are unaffected).
