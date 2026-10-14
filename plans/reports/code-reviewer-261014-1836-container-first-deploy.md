# Code review: PR #215 container-first MCP deploy

Branch `ci/mcp-deploy-container-first` @ fb5f715. Files: `.github/workflows/deploy-mcp.yml`, `worker/scripts/roll-out-job-container.mjs` (new, 161 LOC), `AGENTS.md`.
Checked against wrangler 4.149.0 `worker/node_modules/wrangler/wrangler-dist/cli.js`. No Cloudflare API calls were made. Local Docker 29.4 (overlay2 store) and a throwaway localhost `registry:2` were used for the digest and dockerignore experiments.

## Verdict

The approach is sound and matches wrangler's calls. No blocking defects. The cases where the guarantee leaks are listed below. The biggest gaps are the skip-if-same-image shortcut and the AGENTS.md rule, which covers only one direction of compatibility.

## Verified against wrangler source

| Claim | Evidence | Result |
|---|---|---|
| Worker goes live before container push and rollout | cli.js:181058 `Uploaded` -> 181074 `pushBuiltContainerImage` -> 181089 `deployContainers` -> `apply` | Confirmed. The image is built before the upload (`buildContainerImages`), then pushed and rolled out after it. |
| Build flags are the same | `constructBuildCommand` cli.js:145290: `build --load -t <tag> --platform linux/amd64 --provenance=false [--build-arg..] [--network host if WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST] -f - <ctx>` | Same. There are no `image_vars` and the env var is unset. |
| A fully cached rebuild gives the same image ID | Local experiment: two `-f -` builds with different tags gave the same `sha256:9c3d…` | Confirmed. |
| `containers push` leaves a RepoDigest that the rebuilt image inherits | `pushCommand` cli.js:145570 -> `tagAndPushImage` (tags `registry.cloudflare.com/<accountId>/<name>:<tag>` and pushes). Local experiment: after the push, both the source tag and a later cache-hit rebuild under a new tag list `localhost:5917/acct/rv-test@sha256:9b69…`, which equals the remote manifest digest. | Confirmed (classic store). |
| wrangler then skips the push and sees no change | `pushImageIfChanged` cli.js:145409: `findRemoteDigest` on the rebuilt image matches repo `registry.cloudflare.com/<ext>/multix-mcp-multixjobcontainer` -> `manifest inspect` -> "Image already exists remotely, skipping push". It returns `<repo>@sha256:X`, the same string the script PATCHes. `apply` -> `cleanApplicationFromAPI`/`mergeDeep2`/`Diff` -> "No changes to be made". | Confirmed. |
| App name | cli.js:27759 `${name}-${class_name}`, lowercased | `multix-mcp-multixjobcontainer` is correct. |
| Rollout steps | cli.js:203888 `max_instances < 2 ? 100 : [10, 100]`. The 25% default (cli.js:222937) is only on the legacy `cloudchamber apply` path. This container has no `scheduling_policy: durable_object`, so it takes the `apply()` path. | `[10, 100]` matches. |
| Rollout body | `doAction` cli.js:154009: `{description, strategy: "rolling", target_configuration, steps:[{step_size:{percentage}, description}], kind}`. The kind enum for create is `full_auto` or `full_manual` only; `durable_objects_auto` is response-only. | Same shape; `full_auto` is correct. |
| Base URL | `getAPIUrl` cli.js:193322 `/accounts/<id>/containers` | Same. |
| Terminal statuses | Enum cli.js:151491: pending, progressing, completed, reverted, replaced | The script fails on reverted or replaced, which is correct. |
| Account namespace | The push uses `CLOUDFLARE_ACCOUNT_ID`; deploy uses `external_account_id`. `apply` calls `resolveImageName(accountId, …)`, which throws if a 32-hex namespace differs. | wrangler already requires the two to be equal, so the script's prefix check is safe. |

## Findings (ranked)

### Medium

**M1. The skip-if-same-image shortcut does not look at rollout state** (roll-out-job-container.mjs:143-146)
It returns early when `app.configuration.image === image` without checking that a rollout to that image finished.
Scenario: run A PATCHes, then the POST fails, times out, or the run is cancelled (concurrency is serial, but a manual cancel kills the poller while the rollout keeps going). If run B builds the same digest, it exits 0 and `wrangler deploy` activates the Worker over a partial or missing rollout. That is exactly the case this PR is meant to prevent.
Today this is mostly latent: builds are not reproducible across runners (RUN layer and COPY mtimes change), so a re-run gets a new digest and does a fresh PATCH+POST. It becomes real as soon as someone adds `cache-from`, `SOURCE_DATE_EPOCH` or reproducible builds.
Fix: on a match, read `app.active_rollout_id` (wrangler reads it at cli.js:146411). Wait on it if it is set. If it is not set and the last rollout is not `completed` with this image, POST a rollout anyway.

**M2. AGENTS.md covers only Worker -> container, not container -> Worker** (AGENTS.md:119-124)
Once the container rolls out first, the old live Worker reads the new container's responses. Examples: `GET /jobs/current` parsed in `worker/src/jobs/job-controller.ts:157`, cancel responses, and the R2 output keys and layout the container writes.
The rule only says "accept the job spec sent by the Worker". A container change that renames a status field or changes the output key layout would break the live Worker during the window, and the rule would not catch it.
Suggested wording: "...a new container must still accept the job spec the live Worker sends **and return responses and outputs that the live Worker can read**."
Optional addition: a Worker rollback (`wrangler rollback`) does not roll containers back, so "live" includes any version you might roll back to.

### Low

**L1. The PATCH body carries every field returned by GET** (:147). wrangler PATCHes only its own fields, with `instance_type`; the GET response carries `vcpu`/`memory_mib`/`disk`/`memory` (see `cleanApplicationFromAPI` / `inferInstanceType` cli.js:145188, 146566). The PR body says a no-op PATCH with the app's own configuration returned 200, so the API accepts this shape. It fails closed if that ever changes. A side effect: if `instance_type` changes in `wrangler.jsonc` in the same commit, the script rolls out the old instance type, and `wrangler deploy` then diffs and starts a **second, Worker-first rollout**. The workflow comment at deploy-mcp.yml:71-73 hints at this; it is acceptable, but it should be stated plainly.

**L2. A cache miss on the second build causes a double rollout** (deploy-mcp.yml:74). If BuildKit GC or any context change between the steps causes a miss, wrangler gets a new image ID with no RepoDigest, pushes a new digest, and does a full_auto [10,100] rollout **after** activating the Worker. The harm: a second SIGTERM of every running instance (job-server.mjs:111 aborts the in-flight CLI job), and that second rollout is Worker-first. No data corruption. It is unlikely on one runner because nothing in the context changes between steps. A cheap guard: fail or warn if `wrangler deploy` output contains "Image does not exist remotely, pushing".

**L3. A transient API error kills the poll** (:126 via `api()`). One 5xx or network blip on GET rollout throws, the job fails, and the Worker is not deployed, while the rollout continues. It fails closed, but it is noisy. Suggest retrying GETs 2-3 times.

**L4. No fetch timeout and no job `timeout-minutes`** (:58, deploy-mcp.yml:31). A hung request stalls until GitHub's 6 h job cap, and holds the `deploy-mcp` concurrency group the whole time. Add `signal: AbortSignal.timeout(30_000)`, `timeout-minutes: 45` on the job, or both.

**L5. The post-push digest lookup has no fallback** (:106-112). wrangler falls back to `docker manifest inspect -v` when RepoDigests lacks the repo (cli.js:145515), for example on a containerd image store. The script throws instead (fail-closed). I could not test this on a containerd store. Mirroring the fallback would cost about 5 lines.

**L6. The image-size limit check is skipped.** `containers push` does not run `ensureContainerLimits` (wrangler deploy runs it before pushing). An oversized image is pushed and PATCHed, and the failure surfaces as a rollout error rather than a clear message. Fails closed.

### Informational

- **I1. Dockerfile.dockerignore is not honoured with `-f -`.** Local experiment: the `-f -` build context included everything, while `-f path/Dockerfile` honoured `Dockerfile.dockerignore`. The script and wrangler behave the same, so cache parity holds. Image contents are unaffected because the Dockerfile COPYs explicit paths. The cost: the whole repo (`.git`, `node_modules`, `worker/node_modules`, `docs-site`) is sent as context twice per deploy, and the comment at the top of `Dockerfile.dockerignore` is misleading. A root `.dockerignore` would fix both builds. This predates the PR, so it belongs in a separate issue.
- **I2. Secrets.** The token is only in the `authorization` header and is never logged. Error text includes the API path, which contains the account ID; GitHub masks the account ID as a secret, and so does wrangler's `Pushed image:` line. `docker login` uses `--password-stdin` (cli.js:144735). Child processes inherit env, but nothing forwards it into the build (no `--build-arg`/`--secret`). OK.
- **I3. Wiring.** The script resolves paths absolutely, so running it from the repo root is fine. `npx wrangler` runs from `worker/` and resolves the local wrangler. Env is passed explicitly to both steps. `concurrency: deploy-mcp, cancel-in-progress: false` serialises runs. A manual local `wrangler deploy` during a CI rollout would make the CI rollout `replaced`, which fails closed.
- **I4. The 20 min cap is reasonable.** The job server exits within 10 s of SIGTERM (job-server.mjs:111-115), so a step does not sit on the platform's 15 min SIGKILL wait. Each rollout still aborts in-flight jobs; that also happened before this PR.
- **I5. The `:<sha12>` tag is reused by re-runs of the same commit.** On a re-run the tag is overwritten and the earlier digest is left untagged; since wrangler skips its own push, the running digest has only that tag. This is harmless unless the registry garbage-collects untagged manifests that an app still references (unknown).
- `biome check` is clean on the script and `node --check` passes. The script has no tests (CI glue).

## Recommended actions
1. M1: gate the early exit on rollout state (`active_rollout_id` or latest rollout `completed` for this image).
2. M2: extend the AGENTS.md rule to container responses and outputs read by the live Worker, plus rollback targets.
3. L3/L4: GET retries, a fetch timeout, and job `timeout-minutes`.
4. Optional: L5 fallback; detect the L2 double push in the deploy log.
5. Separate issue: root `.dockerignore` (I1).

## Unresolved questions
- Does a PATCH of `configuration` without a rollout change the image used by newly started DO instances? It matters for the "PATCH ok, POST failed" state. wrangler has the same non-atomic sequence.
- RepoDigests behaviour on the containerd image store (the GitHub runner Docker default may change). wrangler depends on it in the same way, but the script lacks wrangler's fallback.
- Does the Cloudflare registry GC untagged manifests (I5)?

Status: DONE_WITH_CONCERNS
Summary: Calls, flags, steps and digest parity match wrangler 4.149.0 (verified in source and by local Docker experiments). Two medium gaps: the skip-if-same-image shortcut ignores rollout state, and AGENTS.md covers only Worker->container compatibility.
