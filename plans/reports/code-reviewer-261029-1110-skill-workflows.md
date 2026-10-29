# Code review: skill workflows (#432)

## Scope
- Reviewed: worker/src/skills/workflow-{manifest,store,manager,tool}.ts, worker/src/api/workflow-api-handlers.ts, and the diffs to account-skills.ts, skill-registry.ts, skill-catalog.ts, mcp-server.ts, api-router.ts, api-http.ts and the tests. Docs were not reviewed.
- The change was committed during the review as 139e36d (merged in 6ea51e5, which does not touch these files). Line numbers refer to HEAD.
- Checks run: worker typecheck passed. Biome passed on the touched files. Worker vitest: 561/561 passed. `npm run check:mcp`: bundle clean.
- Probes: two throwaway vitest probes in the scratchpad, none in the repo. They confirmed H1, M1 and L2.

## Overall
Most of the security model holds. I traced these paths:
- Authorization is REST-only, because REST accepts only API keys and the MCP tool has no authorize action.
- Runs are scoped to the caller's own Durable Object (DO), because `owner()` checks the account and run ids are looked up only in the caller's store.
- A grantee only reads from the owner's DO, through `served` and `readFile`, and that read checks the grant.
- Templates cannot add flags: prepareRun passes values as `--name=value` and puts positionals after `--`.
- The URL guard applies to url inputs and to step outputs, because both reach prepareRun's `resolveInputs` and `urlOptions`.
- Revoking or replacing the authorization, a new revision, a recreated skill and a withdrawn grant all stop the run at the next step.
- The spend guard and cost preflight match multix_run.

The weak spot is the step-start state machine when the infrastructure fails partway.

## Critical
None found.

## High

### H1. A step's job can start twice; the first job is orphaned and its cost is never counted
- Where: worker/src/skills/workflow-manager.ts:502-561. The job starts at L535, the non-Multix catch is at L547-551, and the final save is at L556.
- Failure path, confirmed with a probe:
  1. The lease is saved at version v+1.
  2. `runner.run` starts the job.
  3. The final `saveWorkflowRun` throws, for example on a DO reset or overload, or an RPC error. The exception propagates.
  4. The run is left with `status: "starting"`, no `jobId`, and the lease set.
  5. After 2 minutes the next `status` call takes a new lease and starts a second job.
  6. The first job keeps running and is billed to the user's keys. Nobody follows it. Its estimate is never added to `spentUsd`, so `max_cost_usd` does not cover it, and its outputs are lost.
- Probe output: the step was `starting` with `job_id: null` after the failure, and after the lease expired the backend had started 2 jobs.
- A second path: `runner.run` throws a non-MultixError after `backend.start` may already have started the container. Examples are a KV error in `store.create` or a backend RPC timeout. The catch at L547-551 resets the step to `pending` and clears the lease at once, so the next read starts another job with no 2-minute delay. JobRunner has also released the quota slot, so the orphan runs outside the per-account cap.
- Why it matters: the plan promises that a step starts once and that `max_cost_usd` is enforced across steps. Unlike multix_run, where retrying is the client's choice, the run retries on its own.
- Fix:
  - Choose the job id before starting and persist it in the lease, for example `lease: { id, until, jobId }`. Let `JobRunner.run` accept a caller-supplied job id.
  - When a later reader finds an expired lease that has a `jobId`, call `runner.status(jobId)` first. Adopt the job if it exists, and start a new one only on `JobNotFoundError`.
  - In the non-MultixError path, keep the lease and its `jobId` instead of clearing them.
  - Add a test where `saveWorkflowRun` throws after the job started.

## Medium

### M1. A missing optional input shifts later positionals into an earlier slot
- Where: worker/src/skills/workflow-manifest.ts:413-417 (`strings` uses `flatMap` and drops `undefined`) and L420 (`args`).
- With `args: ["{{inputs.a}}", "{{inputs.b}}"]`, `a` optional and absent, and `b = "B"`, the rendered args are `["B"]`. The probe confirmed this. b's value lands in the first positional (positionalValues takes them in queue order).
- The run inputs are chosen by the MCP caller, so the model controls this. It breaks what the user authorized: each value in its declared place. It does not add flags.
- Fix, either of:
  - At parse time, refuse a whole-template `args` element that refers to an optional input without a default, unless it is the last element.
  - At render time, fail the step when a dropped arg is followed by a kept one.
- Add a test for it.

### M2. Listing and starting runs load every full run record
- Where:
  - worker/src/skills/workflow-store.ts:143-146: `runs()` returns up to 50 full `WorkflowRun`s.
  - worker/src/skills/workflow-store.ts:152-163: `createRun` lists every run without a limit, inside `blockConcurrencyWhile`.
  - worker/src/skills/workflow-manager.ts:410-416: `list()` makes a summary from them.
- Each record carries the parsed manifest (up to 64 KiB), the inputs (up to 20 × 16,000 characters) and the outputs, so a record can be about 400 KB. Fifty of them are about 20 MB, sent over DO RPC on every `list` and every start. That is close to the 32 MiB RPC limit and a real share of the 128 MB Worker memory.
- The account's skills DO is also blocked during `createRun`, and grantees read the owner's skills through that same object.
- Fix:
  - Keep a small index entry per run, for example `wfidx:<id>` holding `{status, uri, createdAt}`.
  - Build the summaries inside the DO, and have `createRun` read only the index.
  - Optionally store the manifest once per digest rather than once per run.

## Low

### L1. Cancelling while a step is starting still starts a paid job
- Where: workflow-manager.ts:389-408 and 535-559.
- If cancel commits while another request holds the lease, the starter still calls `runner.run` and only then cancels the job (L559). The provider call may already have been sent and billed.
- Fix: just before `runner.run`, re-read the run. If its version is no longer the leased one, give up and start nothing. A small window remains, but it becomes milliseconds instead of the whole container start-up.
- There is no test for cancel during `starting`.

### L2. Inherited object keys pass name checks
- Where: workflow-manifest.ts:129 (`ref.input in inputs`), L364 (`name in manifest.inputs`) and L392 (`inputs[ref.input]`).
- `{{inputs.constructor}}` passes manifest validation without being declared, and renders as `"function Object() { [native code] }"` (confirmed by probe).
- A run input named `hasOwnProperty` is silently accepted instead of being refused as an unknown input.
- Impact is limited to text junk and skipped validation, with no injection, but it bypasses the "references only declared inputs" rule.
- Fix: use `Object.hasOwn(...)` in all three places, or build the records with `Object.create(null)`.

### L3. The lease is taken before the job context is checked
- Where: workflow-manager.ts:511 and 384-387.
- `this.runner()` is called after the lease save and outside the `try`. On a context without `jobs`, `status()` therefore leaves the step `starting` with a 2-minute lease and then throws `unavailable`.
- Fix: call `this.runner()` at the top of `status()`, as `start()` already does, or before taking the lease.

### L4. Any API key can authorize workflows
- Where: worker/src/api/api-router.ts authenticate, and workflow-api-handlers.ts:66-93.
- API keys have no scopes. A key given to an agent or CI for `/api/v1/jobs` can also `POST /workflow-authorizations`.
- The MCP OAuth token cannot authorize (verified: REST accepts only `ApiKeyStore` keys), so the plan's guarantee holds as written. But "a model cannot authorize its own runs" only holds if no API key reaches the model.
- This is a product decision: a per-key scope, or authorization only from the dashboard. See the questions at the end.

### L5. The URI namespace is not checked against the skill's visibility
- Where: workflow-manager.ts:201-226.
- `SkillCatalog.servedFor` refuses a `private` URI for a team skill, and the reverse. `WorkflowManager.load` does not, so `skill://team/<me>/<name>` resolves the caller's own private skill.
- This is harmless because canRead still refuses other accounts' non-team skills. The run and authorization then store a URI form that does not match the skill.
- Fix: apply the same `visibility === expected` check.

### L6. The spend-guard refusal sends workflow users to the wrong place
- Where: workflow-manager.ts:527 (assertSpendGuard with `remaining`).
- With `MULTIX_MCP_UNCAPPED_SPEND=budget` and an authorization without `max_cost_usd`, the step fails with "Pass max_cost_usd". For workflows the fix is to re-authorize with `max_cost_usd`, not to pass a tool argument.
- Fix: catch the error and rephrase it, or document this in the describe note.

### L7. Unredacted job error text is stored and returned
- Where: workflow-manager.ts:466.
- The step's job `error` is stored in the run record and returned by REST `GET /workflow-runs/{id}` as is. It has key and R2-credential scrubbing (jobPayload), but URL query strings are not redacted, unlike `sanitizeText`.
- This is the same exposure as `GET /jobs/{id}` and only reaches the owner, but now it is also persisted in the DO.
- Optional: pass it through `sanitizeText` before storing.

## Consistency with multix_run
- These match exactly: `prepareRun` (catalog, policy, caps, URL guard), `assertSpendGuard` with the remaining budget, strict policy when the run is uncapped, and `checkBudget`.
- Shared limitation, not new here: the estimate uses the pre-cap `request.options`, so values that `applyCaps` fills in (default duration, resolution) are not priced. A whole-run cap adds up this gap over up to 10 steps.

## Test gaps that matter
1. Final save fails after the job started, and lease expiry or takeover (H1).
2. Cancel while the step is `starting` (L1).
3. A positional `args` element with an absent optional input, and an `args` value starting with `-` reaching argv after `--` (M1). The current flag-injection test only covers an option value.
4. Pruning beyond `MAX_STORED_RUNS`, and that active runs are never pruned.
5. Inherited-key names: `{{inputs.constructor}}` and the run input `hasOwnProperty` (L2).
6. A team grantee's run when the owner switches the skill to private with the same revision and digest. The code handles it through canRead, but no test covers it.

## Plan follow-ups
- Every acceptance item in plan.md is implemented and tested.
- "Two concurrent readers start a step once" holds only while the infrastructure is healthy (H1).
- Not run here: root lint, root build and test, `verify:docs` (docs were out of scope).

## Unresolved questions
1. Should workflow authorization need a dedicated API-key scope, or the dashboard only (L4)?
2. Is "a run advances only when read" acceptable when a pending step can hold one of the 5 active slots indefinitely, or should a stale `pending` run expire?

Status: DONE_WITH_CONCERNS
Summary: The authorization, isolation, template and URL-guard boundaries hold under tracing. A partial infrastructure failure in step start can launch a duplicate paid job outside the cost cap (H1), and missing optional inputs shift positionals (M1).
Concerns/Blockers: The change was committed (139e36d) while the review was running; the findings apply to HEAD.

## Resolution

| Finding | Outcome |
|---|---|
| H1 | Fixed. The job id is chosen before the step starts and kept in the lease together with the estimate. A reader that finds the lease expired adopts the job (`runner.status`), and starts the step again only on `JobNotFoundError`. An error after the job may have started keeps the lease. Tests: "adopts a job whose start was not recorded…" (checked by mutation: it fails when adoption is removed) and "starts the step again when an expired lease's job never started". |
| M1 | Fixed. A positional that is exactly an optional input without a default is refused when the manifest is parsed. |
| M2 | Fixed. A `wfruns` index of summaries is kept in the same put as each run. Listing and the active and stored limits read only the index. |
| L1 | Fixed. The run is saved (with a version check) just before `runner.run`, so a cancel wins and no job starts. Cancel also stops the job id held by the lease. |
| L2 | Fixed. `Object.hasOwn` for input references, run input names and rendering. |
| L3 | Fixed. `startStep` requires the runner before it takes the lease. |
| L4 | Not changed: product decision. Opened as #479. |
| L5 | Fixed. `load()` returns the URI form that matches the skill's visibility. |
| L6 | Fixed. The spend-guard message tells the caller to authorize the workflow again with `max_cost_usd`. |
| L7 | Fixed. A step job's error goes through `sanitizeText`, which removes keys and URL query strings, before it is stored. |
| Open question: an unread pending run holds an active slot | Opened as #480. Cancel frees the slot today. |
