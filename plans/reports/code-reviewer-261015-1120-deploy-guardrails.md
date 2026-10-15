# Code review: 68d9698 ci(mcp) apply drifted container settings, deploy only from main

Branch `ci/deploy-guardrails`, issue #218. Read-only review.

## Scope
- `.github/workflows/deploy-mcp.yml`, `worker/scripts/roll-out-job-container.mjs`, `AGENTS.md`, `worker/wrangler.jsonc` (+71/-20)
- Checks run: `node --check` on the script (ok), `actionlint` on the workflow (clean). Biome not installed in this worktree, so not run.
- wrangler 4.149.0 source read from the npm tarball (`wrangler-dist/cli.js`) to check what `--containers-rollout=gradual` actually does.

## Verdict
The output wiring and the expression are correct. wrangler's gradual path does apply `max_instances` and the instance type. No blockers. There is one medium issue (concurrency interacting with the guard). The other medium issue is the guard's threat model: it is a guardrail, not a security boundary. The rest are low-severity robustness and doc gaps.

## Verified correct
- **Output on early exit:** `reportSettingsDrift(app)` (script:219) runs before both `process.exit(0)` branches (script:228, :233), so `settings_changed` is always written once the app has been found. If `buildAndPush`/`findApplication` throws, the step fails and the Worker step is skipped, so a missing output never matters. With `GITHUB_OUTPUT` unset (local run), nothing is written.
- **Expression (yml:92):** `(inputs.apply_container_settings || steps.container.outputs.settings_changed == 'true') && 'gradual' || 'none'`. On push, `inputs.*` is null (falsy). A missing output is `''` (not `'true'`). Both results are non-empty literals, so the `&&/||` ternary idiom is safe. Only literals get interpolated into `run:`, so there is no injection path. `${GITHUB_REF}` in the guard is a shell env var, not `${{ }}`, so it is safe too.
- **Guard (yml:43-47):** push is already limited to `branches: [main]`. A dispatch from a branch or tag gets `refs/heads/x` or `refs/tags/x` and fails before checkout and before any step that receives secrets.
- **The gradual rollout really applies the settings (wrangler 4.149 `apply()`, cli.js ~146372-146510):**
  - It builds `modifyReq` via `createApplicationToModifyApplication`, which includes `configuration` (vcpu/memory/disk derived from `instance_type`) and `max_instances`.
  - It diffs against the live app, calls `ApplicationsService.modifyApplication`, then calls `createApplicationRollout` when `hasRolloutDiff` is true. `hasRolloutDiff` compares the whole app, so a change to `max_instances` alone also rolls out.
  - Order is upload Worker, then `deployContainers` (cli.js:181058-181097), which matches "after the Worker deploy" in AGENTS.md.
  - If there is no diff, wrangler prints "No changes to be made". So a false positive only costs a docker build and push; it does not break anything.
- **`INSTANCE_TYPES` (script:165-174)** matches wrangler 4.149 `instanceTypes` exactly (cli.js:153420). wrangler's own `inferInstanceType` uses the same `vcpu`/`memory_mib`/`disk.size_mb` comparison, so the check matches how wrangler sees the live app.

## Findings (by severity)

### Medium

**M1. A dispatch from a non-main ref can cancel a pending main deploy** (`deploy-mcp.yml:31-33` together with `:43`)
- The workflow-level `concurrency: deploy-mcp` with `cancel-in-progress: false` means GitHub keeps one running run and one pending run. A newly queued run cancels the existing pending run.
- Scenario: a main push is pending behind a running deploy. Someone dispatches from a feature branch. That dispatch replaces the main push run, then fails at "Require main". Main's commit never deploys until the next push or a manual run.
- The guard sits inside the job, after the concurrency slot has already been taken.
- Fix: keep rejected refs out of the shared group, for example:
  ```yaml
  concurrency:
    group: ${{ github.ref == 'refs/heads/main' && 'deploy-mcp' || format('deploy-mcp-rejected-{0}', github.run_id) }}
    cancel-in-progress: false
  ```

**M2. The main-only guard is accident prevention, not an access control** (`deploy-mcp.yml:42-47`)
- `workflow_dispatch` runs the workflow file from the selected ref. A branch that deletes or edits the "Require main" step deploys from that branch anyway.
- `CLOUDFLARE_API_TOKEN` is a repo secret, so any write-access contributor can also add a new workflow on a branch and use the token directly.
- The commit message ("Manual runs from any ref other than main now fail") and AGENTS.md:129 ("The workflow deploys only from main") describe the current file accurately, but they read as a guarantee.
- If production-only-from-main is meant as a control: add a GitHub Environment (for example `production`) with a deployment branch policy of `main` only, move `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` into it, and set `environment: production` on the job. Keep the step as a fast, readable failure.
- If this is out of scope for #218, open a separate hardening issue per AGENTS.md.

### Low

**L1. Regex parsing of JSONC matches the first occurrence, including inside comments** (`script:184`, `:188`)
- A comment like `// was "max_instances": 5` or a commented-out `"instance_type": "standard-1"` placed above the real key wins.
- The comments in wrangler.jsonc today do not contain a quoted key, so current behavior is correct, but it is fragile.
- Fix options:
  - `import { unstable_readConfig } from "wrangler"` (exported in 4.149; `worker/` deps are installed before this step) and read `config.containers[0]`.
  - Strip `//` and `/* */` comments before matching.
  - Scope the match to the `containers` block.

**L2. Absent keys never count as drift, but wrangler applies defaults** (`script:185`, `:191-194`)
- If `max_instances` is removed, wrangler sends `max_instances: 20` (cli.js:203905, `container.max_instances ?? 20`).
- If `instance_type` is removed, wrangler sends `lite` (cli.js:203953).
- In both cases the script reports no drift, the deploy uses `none`, and the live app silently keeps the old values. The same blind spot covers a custom `instance_type` object or the deprecated `configuration: {vcpu,…}` form: the regex does not match, so there is no drift.
- Fix: treat absent as wrangler's default (`max_instances` 20, type `lite`), and treat an object `instance_type` as drift, or fail.

**L3. `max_instances` undefined on the live app now always counts as drift** (`script:185`)
- The old code guarded `app.max_instances !== undefined`. The new code drops that, so if the API ever omits the field, every deploy runs a gradual rollout.
- This is harmless (wrangler's diff is a no-op or a same-image rollout) and arguably the safe direction. It is noted only because the behavior changed and the log would print `max_instances undefined -> 10`.

**L4. AGENTS.md no longer says what to do for other `containers` block changes** (`AGENTS.md:126-129`, `wrangler.jsonc:56-57`)
- The old text covered "the `containers` block" in general. The new text covers only `instance_type` and `max_instances`.
- Other fields wrangler applies are not detected, so they need a manual `apply_container_settings` run: `constraints`, `scheduling_policy`, `rollout_active_grace_period`, `rollout_step_percentage`, container `observability` (which follows the root `observability` too), and `ssh`/`authorized_keys`.
- Add one sentence such as: "Other changes to the `containers` block still need a manual run with `apply_container_settings`." The wrangler.jsonc comment is accurate as written (it names only those two fields), but it could carry the same pointer.

**L5. "The same image" in the yml:85-90 comment and the input description is an assumption**
- With `gradual`, wrangler rebuilds and pushes via `pushBuiltContainerImage(builtImage, versionId, …)`. It is only the same digest if the docker build is a cache hit with an identical manifest. The script mirrors wrangler's build flags to make that likely, and the same job reuses the local build cache.
- If it is not the same image, the container rollout would happen after the Worker activates, which is exactly what #215 was meant to avoid. This is low risk because the content is the same commit's Dockerfile.
- Worth confirming once from the logs of the first drift run: wrangler's displayed diff should show only `instance_type`/`max_instances`, not `image`.

### Info
- Unknown `instance_type` (script:191-192) is reported as drift, so wrangler gets the job and fails validation loudly. That is fine.
- `lite`/`dev` and `standard`/`standard-1` share resources. A rename between aliases correctly counts as no drift (wrangler canonicalises the same way).
- Float comparison `0.0625`/`0.25` is exact in binary, and the API returns JSON numbers, so there is no epsilon issue.

## Positive notes (risk calibration)
- Drift detection reads the app before the script's PATCH, so it compares against the pre-run state. On a re-run after a failed Worker step, drift is detected again, so the settings are not lost.
- The guard step runs before checkout, and secrets are only passed to later steps.

## Recommended actions
1. M1: key the concurrency group by ref (one-line fix).
2. L4: add the "other containers fields still need apply_container_settings" sentence to AGENTS.md.
3. L1/L2: switch to `unstable_readConfig` (also fixes defaults and the object form), or at least strip comments.
4. M2: open a follow-up issue for a `production` environment with a main-only branch policy and environment-scoped secrets.

## Unresolved questions
- Is the main-only guard meant as a real control (then environment protection is needed) or just a footgun guard?
- Does the wrangler gradual push resolve to the same `remoteDigest` as the script's push? This needs one observed drift run to confirm.
- Should removing `max_instances`/`instance_type` from wrangler.jsonc be treated as drift toward wrangler's defaults (20 / `lite`)?
