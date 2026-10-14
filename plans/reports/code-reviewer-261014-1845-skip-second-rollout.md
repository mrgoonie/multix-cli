# Code review: PR #217 ci(mcp): skip the second container rollout in the Worker deploy

Branch `ci/mcp-skip-second-rollout` @ 688e380 (vs main 0581ba7). Reviewer did not write it. Static review only; no Cloudflare calls, no deploy.
Wrangler source: `worker/node_modules/wrangler/wrangler-dist/cli.js` (4.149.0).

## Scope
- `.github/workflows/deploy-mcp.yml` (+11/-4), `AGENTS.md` (+4/-1)
- Context read: `worker/scripts/roll-out-job-container.mjs`, `worker/wrangler.jsonc`, `worker/package.json`, `worker/src/config.ts`

## Verdict
Change is correct and fails closed. No blockers. One medium doc/drift gap, rest low/info.

## Verification of the five questions

### 1. Metadata uploaded with `--containers-rollout=none`
- `deployWorker` (cli.js:180663-180690): `skipContainerChanges` -> `getContainerMetadataForRolloutSkip`; local `getContainerMetadata` is NOT used for an existing Worker.
- `getContainerMetadataForRolloutSkip` (cli.js:168204-168278): fetches every version in the latest deployment and re-uploads their `resources.script_runtime.containers` verbatim (must be deep-equal across versions). So the new version carries whatever the previous normal deploy recorded.
- For this app (`containers[0]` has no `scheduling_policy: "durable_object"`, cli.js:315-317), `getContainerMetadata` (cli.js:168173-168202) only ever emits `{ name?, class_name }`; `images` exists only for DO-managed apps. Image lives on the container application, linked by DO namespace id, not on the Worker version.
- Conclusion: no image pinning possible; DO binding `MULTIX_JOBS -> MultixJobContainer` keeps its container metadata. Confirmed.
- Nit: PR body says "`getContainerMetadata` records only `{ name, class_name }`" for the Worker step. Under `none` it is actually the copied deployed metadata (same shape, since earlier deploys came from `getContainerMetadata`). Conclusion holds; reasoning slightly off.

### 2. Validation skipped / failure modes under `none`
Skipped: docker build (cli.js:239937), `fillOpenAPIConfiguration` (cli.js:295739), `deployContainers` incl. its DO-namespace match check and `ensureContainerLimits` (cli.js:181058, 146394-146410, 145424). Still run: config validation, `resolveExportsUploadPayload` (DO exports/sqlite), upload API checks.
- Namespace check only matters on DO class rename/namespace change: not a push-path scenario (and `APP_NAME` is hardcoded in the roll-out script, roll-out-job-container.mjs:32, so a rename breaks step 1 anyway).
- Image size limits: `wrangler containers push` in the script (roll-out-job-container.mjs:106) still goes through the push path.
- Fails closed with UserError before upload when: latest deployment has no versions / unreadable (cli.js:168231-168238), or a split deployment has differing/partial container metadata (cli.js:168256-168267). Failure leaves container already rolled out and Worker old - acceptable (container must be backward compatible per AGENTS.md).
- Does NOT fail when no deployed version has container metadata: returns `containers: undefined` (cli.js:168252-168255) and uploads without it. See Low-1.

### 3. Expression
`${{ inputs.apply_container_settings && 'gradual' || 'none' }}` (deploy-mcp.yml:83)
- push: `inputs` is empty -> `null && ...` -> `null || 'none'` -> `none`. Correct.
- dispatch true: `inputs` keeps boolean type -> `'gradual'` (truthy, so `&&/||` idiom safe). dispatch false -> `none`.
- Correctly uses `inputs`, not `github.event.inputs` (string `'false'` would be truthy). Output is one of two literals; no injection surface.

### 4. `gradual` on manual run
- Wrangler rebuilds (cache hit), `pushImageIfChanged` (cli.js:145409-145470) reuses the remote digest when the local image's RepoDigests already contain it, else pushes a new digest of the same source. `apply` (cli.js:146372+) then PATCHes with jsonc config (instance_type, max_instances; cli.js:146326-146350) and starts a rollout AFTER the Worker is live, not awaited.
- Hazard: same code either way, so no Worker/container skew. Cost is a second restart of every instance (in-flight jobs disrupted twice) - the trade-off the input description states. Acceptable as an opt-in.
- Script step 1 still runs first on a manual run, so a manual run on unchanged HEAD hits the "already runs this image" early exit (roll-out-job-container.mjs:164-172) and only wrangler's rollout happens. Fine.

### 5. Config the PATCH copies
`configuration = { ...app.configuration, image }` (roll-out-job-container.mjs:163) copies LIVE config; `max_instances` is application-level and never sent. So on push, edits to `instance_type`, `max_instances`, observability, ssh, etc. in the `containers` block are silently not applied. Documented in deploy-mcp.yml:77-81, input description deploy-mcp.yml:22-25, AGENTS.md:126-129. See Medium-1 for the gap.

## Critical
None.

## High
None.

## Medium
**M1. Silent drift between `wrangler.jsonc` containers block and live app; coupled Worker var can outrun it.** deploy-mcp.yml:83, roll-out-job-container.mjs:163, wrangler.jsonc:55-57/80
- Push deploys apply `MULTIX_MAX_JOBS_TOTAL` (a Worker var) but not `max_instances`. A PR that raises both (as the jsonc comment instructs) lands with the Worker cap above the platform ceiling until someone remembers the manual run. Handled at runtime ("every job container is in use", job-protocol.ts:86) so degraded, not broken - but nothing in CI flags it.
- Doc relies on memory: AGENTS.md note is in a paragraph about container compatibility, not near the jsonc block a contributor edits.
- Fix (pick one, cheap): (a) add a comment above `containers` in `worker/wrangler.jsonc` pointing at the manual run; (b) in the roll-out script, compare `app.configuration.instance_type` and `app.max_instances` with the jsonc values and print `::warning::` (or fail) on mismatch. (b) turns forgotten manual runs into visible CI output.

## Low
**L1. Upload without container metadata if deployed versions lack it.** cli.js:168252-168255. If the live deployment was ever a version without `script_runtime.containers` (e.g. rollback to a pre-container version, or a non-wrangler upload), `none` keeps propagating that and the container DO class would lack container wiring. Not reachable from the current history (all deploys were normal wrangler deploys), and a manual `apply_container_settings` run repairs it. Worth one line in AGENTS.md or the workflow comment: "if a deploy ever loses the container binding, re-run with apply_container_settings."

**L2. PR body reasoning (see Q1 nit).** Not a code issue; fine to leave.

## Info (pre-existing, out of scope - open separate issue if wanted)
- `workflow_dispatch` can be run on any branch ref and deploys that ref to production; the new input makes manual runs more routine. Consider `if: github.ref == 'refs/heads/main'` on the job.
- Input description "Starts a second rollout of the same image" is accurate only when wrangler sees a diff; harmless wording.

## Checks
- Static review of workflow expression and wrangler 4.149.0 source paths above.
- `npx --prefix worker wrangler --version` -> 4.149.0 (matches bundle reviewed).
- Not run: deploy/dry-run against Cloudflare (forbidden). PR body reports `--dry-run` with `none` succeeds; with `dryRun` true the skip path short-circuits at cli.js:168212, so the dry-run does not exercise the metadata-recovery branch that runs in production. First real push after merge is the true test; watch for absence of `EDIT multix-mcp-multixjobcontainer` and no UserError from 168226/168234/168263.

## Unresolved questions
- Should a drift check (M1b) fail the deploy or only warn? Product call.

Status: DONE_WITH_CONCERNS
Summary: `--containers-rollout=none` is safe (copies deployed `{name,class_name}` metadata, no image pin, fails closed) and the expression is correct; only concern is silent jsonc/live container-config drift on push deploys.
